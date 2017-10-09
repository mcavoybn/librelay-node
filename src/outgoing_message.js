// vim: ts=4:sw=4:expandtab

const errors = require('./errors.js');
const libsignal = require('libsignal');
const storage = require('./storage');


class OutgoingMessage {

    constructor(server, timestamp, messageBuffer) {
        this.server = server;
        this.timestamp = timestamp;
        this.messageBuffer = messageBuffer;
        this.sent = [];
        this.errors = [];
        this.created = Date.now();
        this._listeners = {};
    }

    on(event, callback) {
        let handlers = this._listeners[event];
        if (!handlers) {
            handlers = this._listeners[event] = [];
        }
        handlers.push(callback);
    }

    async emit(event) {
        const handlers = this._listeners[event];
        if (!handlers) {
            return;
        }
        const args = Array.from(arguments).slice(1);
        for (const callback of handlers) {
            try {
                await callback.apply(this, args);
            } catch(e) {
                console.error("Event callback error:", e);
            }
        }
    }

    async emitError(addr, reason, error) {
        if (!error || error instanceof errors.ProtocolError && error.code !== 404) {
            error = new errors.OutgoingMessageError(addr, this.messageBuffer,
                                                    this.timestamp, error);
        }
        error.addr = addr;
        error.reason = reason;
        const entry = {
            timestamp: Date.now(),
            error
        };
        this.errors.push(entry);
        await this.emit('error', entry);
    }

    async emitSent(addr) {
        const entry = {
            timestamp: Date.now(),
            addr
        };
        this.sent.push(entry);
        await this.emit('sent', entry);
    }

    async reloadDevicesAndSend(addr, recurse) {
        const deviceIds = await storage.getDeviceIds(addr);
        if (!deviceIds.length) {
            const ourAddr = await storage.getState('addr');
            if (addr === ourAddr) {
                await this.emitSent(addr);
            } else {
                console.warn("Unregistered address:", addr);
                return;
            }
        }
        return await this.doSendMessage(addr, deviceIds, recurse, {});
    }

    async getKeysForAddr(addr, updateDevices, reentrant) {
        const _this = this;
        async function handleResult(response) {
            const jobs = [];
            for (const x of response.devices) {
                jobs.push(async function(device) {
                    device.identityKey = response.identityKey;
                    if (updateDevices === undefined || updateDevices.indexOf(device.deviceId) > -1) {
                        const address = new libsignal.SignalProtocolAddress(addr, device.deviceId);
                        const builder = new libsignal.SessionBuilder(storage, address);
                        try {
                            await builder.processPreKey(device);
                        } catch(e) {
                            if (e.message === "Identity key changed") {
                                if (!reentrant) {
                                    await _this.emit('keychange', addr, device.identityKey);
                                    await _this.getKeysForAddr(addr, updateDevices, /*reentrant*/ true);
                                } else {
                                    throw new errors.OutgoingIdentityKeyError(addr,
                                        _this.messageBuffer, _this.timestamp,
                                        device.identityKey);
                                }
                            } else {
                                throw e;
                            }
                        }
                    }
                }(x));
            }
            await Promise.all(jobs);
        }

        if (updateDevices === undefined) {
            return await (handleResult(await this.server.getKeysForAddr(addr)));
        } else {
            for (const device of updateDevices) {
                /* NOTE: This must be serialized due to a server bug. */
                try {
                    await handleResult(await _this.server.getKeysForAddr(addr, device));
                } catch(e) {
                    if (e instanceof errors.ProtocolError && e.code === 404 && device !== 1) {
                        await _this.removeDeviceIdsForAddr(addr, [device]);
                    } else {
                        throw e;
                    }
                }
            }
        }
    }

    async transmitMessage(addr, jsonData, timestamp) {
        try {
            return await this.server.sendMessages(addr, jsonData, timestamp);
        } catch(e) {
            if (e instanceof errors.ProtocolError && (e.code !== 409 && e.code !== 410)) {
                // 409 and 410 should bubble and be handled by doSendMessage
                // 404 should throw UnregisteredUserError
                // all other network errors can be retried later.
                if (e.code === 404) {
                    throw new errors.UnregisteredUserError(addr, e);
                }
                throw new errors.SendMessageError(addr, jsonData, e, timestamp);
            }
            throw e;
        }
    }

    getPaddedMessageLength(messageLength) {
        var messageLengthWithTerminator = messageLength + 1;
        var messagePartCount = Math.floor(messageLengthWithTerminator / 160);
        if (messageLengthWithTerminator % 160 !== 0) {
            messagePartCount++;
        }
        return messagePartCount * 160;
    }

    async doSendMessage(addr, deviceIds, recurse) {
        const ciphers = {};
        let mBuf = this.messageBuffer;
        const minLen = this.getPaddedMessageLength(mBuf.byteLength + 1) - 1;
        const paddedBuf = new Buffer(minLen);
        paddedBuf.set(mBuf);
        paddedBuf[mBuf.byteLength] = 0x80;
        let messages;
        try {
            messages = await Promise.all(deviceIds.map(id => {
                const address = new libsignal.SignalProtocolAddress(addr, id);
                const sessionCipher = new libsignal.SessionCipher(storage, address);
                ciphers[address.getDeviceId()] = sessionCipher;
                return this.encryptToDevice(address, paddedBuf, sessionCipher);
            }));
        } catch(e) {
            this.emitError(addr, "Failed to create message", e);
            return;
        }
        try {
            await this.transmitMessage(addr, messages, this.timestamp);
        } catch(e) {
            if (e instanceof errors.ProtocolError && (e.code === 410 || e.code === 409)) {
                if (!recurse) {
                    this.emitError(addr, "Hit retry limit attempting to reload device list", e);
                    return;
                }
                if (e.code === 409) {
                    await this.removeDeviceIdsForAddr(addr, e.response.extraDevices);
                } else {
                    await Promise.all(e.response.staleDevices.map(x =>
                        ciphers[x].closeOpenSessionForDevice()));
                }
                const resetDevices = e.code === 410 ? e.response.staleDevices : e.response.missingDevices;
                await this.getKeysForAddr(addr, resetDevices);
                try {
                    await this.reloadDevicesAndSend(addr, (e.code === 409));
                } catch(e) {
                    this.emitError(addr, "Failed to reload device keys", e);
                    return;
                }
            } else {
                this.emitError(addr, "Failed to send message", e);
                return;
            }
        }
        this.emitSent(addr);
    }

    async encryptToDevice(address, mBuf, sessionCipher) {
        const encrypted = await sessionCipher.encrypt(mBuf);
        return this.toJSON(address, encrypted);
    }

    toJSON(address, encryptedMsg) {
        return {
            type: encryptedMsg.type,
            destinationDeviceId: address.getDeviceId(),
            destinationRegistrationId: encryptedMsg.registrationId,
            content: encryptedMsg.body.toString('base64')
        };
    }

    async getStaleDeviceIdsForAddr(addr) {
        const deviceIds = await storage.getDeviceIds(addr);
        if (!deviceIds.length) {
            const ourAddr = await storage.getState('addr');
            if (addr !== ourAddr) {
                deviceIds.push(1); // XXX Mabye just return [];
            }
        }
        const updateDevices = [];
        for (const id of deviceIds) {
            const address = new libsignal.SignalProtocolAddress(addr, id);
            const sessionCipher = new libsignal.SessionCipher(storage, address);
            if (!(await sessionCipher.hasOpenSession())) {
                updateDevices.push(id);
            }
        }
        return updateDevices;
    }

    async removeDeviceIdsForAddr(addr, deviceIdsToRemove) {
        for (const id of deviceIdsToRemove) {
            const encodedAddr = addr + "." + id;
            await storage.removeSession(encodedAddr);
        }
    }

    async sendToAddr(addr) {
        let updateDevices;
        try {
            updateDevices = await this.getStaleDeviceIdsForAddr(addr);
        } catch (error) {
            this.emitError(addr, "Failed to get device ids for address " + addr, error);
        }
        try {
            await this.getKeysForAddr(addr, updateDevices);
        } catch(error) {
            this.emitError(addr, "Failed to retrieve new device keys for address " + addr, error);
        }
        try {
            await this.reloadDevicesAndSend(addr, true);
        } catch(error) {
            this.emitError(addr, "Failed to send to address " + addr, error);
        }
    }
}

module.exports = OutgoingMessage;

