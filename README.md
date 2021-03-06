librelay - Forsta Relay Node.js library
========
Signal based Node.js library for end-to-end crypto with Forsta messaging platform.


[![NPM](https://img.shields.io/npm/v/librelay.svg)](https://www.npmjs.com/package/librelay)
[![License](https://img.shields.io/npm/l/librelay.svg)](https://github.com/ForstaLabs/librelay-node)
[![Change Log](https://img.shields.io/badge/change-log-blue.svg)](https://github.com/ForstaLabs/librelay-node/blob/master/CHANGELOG.md)
[![Docs](https://img.shields.io/badge/docs-api-lightgrey.svg)](https://forstalabs.github.io/librelay-node/index.html)


About
--------
This is a Node.js library used to communicate with the Forsta messaging
platform.  The underlying protocol is based on the Signal end-to-end
crypto system.  The primary differences surround how provisioning is done
and the data payload, which is a custom JSON specification,
<https://goo.gl/eX7gyC>


Installation
--------
Ensure that you are using Node 8 (needs *async/await* support) or higher and
simply install from NPM:

    $ npm install librelay


Storage
--------
Librelay needs a backing store for holding crypto material.  The default
storage backing is `fs` which will store files in your local file-system
under `~/.librelay/storage`.  Redis is also supported by setting
`RELAY_STORAGE_BACKING=redis` in your env or calling
`librelay.storage.setBacking('redis')`.

To support multiple instances of librelay on a single backing store you can
specify a custom label.  This essentially operates as a namespace for all
storage data.  The storage label can be set via the env, a la.
`RELAY_STORAGE_LABEL="special"` or by calling `librelay.storage.setLabel('special')`
from inside your application.

You'll need to ensure your backing store is running properly with a call 
to `await librelay.storage.initialize()`, and if possible you should
tear it down before quitting, with `await librelay.storage.shutdown()`.


Provisioning
-------
PREREQUISITE: To use librelay you must first have a valid Forsta account.  You
can sign-up for free at <https://app.forsta.io/join>.  Once you have a valid
Forsta account you need to provision your librelay based application. 

With your Forsta account (e.g. `myusername:myorgname`) you can get started
with the `registerAccount` function or the `registerDevice` function if adding
supplemental devices.

```javascript
const relay = require('librelay');

async function main(secondary) {
    const userTag = await relay.util.consoleInput("Enter your login (e.g user:org): ");
    const challange = await relay.AtlasClient.requestAuthentication(userTag);
    const prompt = challange.type === 'sms' ? 'SMS Code: ' : 'Password: ';
    await challange.authenticate(await relay.util.consoleInput(prompt));
    if (secondary) {
        const registration = await relay.registerDevice();
        console.info("Awaiting auto-registration response...");
        await registration.done;
        console.info("Successfully registered new device");
    } else {
        await relay.registerAccount();
        console.info("Successfully registered account");
    }
}

main();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/register.js>


Message Receiving
-------
Once your application is provisioned you can participate in the messaging
platform.   The simplest way to get familiar with the platform is to listen
for incoming messages and examine the content sent to your application in a
debugger.   Here is a very simple example of receiving messages.

```javascript
const relay = require('librelay');

function onMessage(ev) {
    const message = ev.data;
    console.info("Got message", message);
}

async function main() {
    const msgReceiver = await relay.MessageReceiver.factory();
    msgReceiver.addEventListener('message', onMessage);
    await msgReceiver.connect();
}

main();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/recvmessage.js>


Message Sending
-------
*This example reads text from standard input and forwards to a hard coded
thread.*
```javascript
const process = require('process');
const relay = require('librelay');

async function main() {
    const argv = process.argv;
    if (argv.length < 4) {
        console.error(`Usage: ${argv[0]} ${argv[1]} TO MESSAGE [THREADID]`);
        return process.exit(2);
    }

    const sender = await relay.MessageSender.factory();
    await sender.send({
        to: argv[2],
        text: argv[3],
        threadId: argv[4] || '00000000-1111-2222-3333-444444444444'
    });
}

main();
```
Ref: <https://github.com/ForstaLabs/librelay-node/blob/master/examples/sendmessage.js>


Cryptography Notice
--------
This distribution includes cryptographic software. The country in which you
currently reside may have restrictions on the import, possession, use, and/or
re-export to another country, of encryption software.  BEFORE using any
encryption software, please check your country's laws, regulations and
policies concerning the import, possession, or use, and re-export of
encryption software, to see if this is permitted.  See
<https://www.wassenaar.org/> for more information.

The U.S. Government Department of Commerce, Bureau of Industry and Security
(BIS), has classified this software as Export Commodity Control Number (ECCN)
5D002.C.1, which includes information security software using or performing
cryptographic functions with asymmetric algorithms.  The form and manner of
this distribution makes it eligible for export under the License Exception ENC
Technology Software Unrestricted (TSU) exception (see the BIS Export
Administration Regulations, Section 740.13) for both object code and source code.


License
--------
Licensed under the GPLv3: http://www.gnu.org/licenses/gpl-3.0.html

* Copyright 2014-2016 Open Whisper Systems
* Copyright 2017-2018 Forsta Inc.
