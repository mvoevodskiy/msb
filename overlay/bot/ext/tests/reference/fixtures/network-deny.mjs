import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => { throw new Error('Network is forbidden in provider reference tests'); };
globalThis.fetch = async () => deny();
http.request = http.get = deny;
https.request = https.get = deny;
net.connect = net.createConnection = deny;
net.Socket.prototype.connect = deny;
net.Server.prototype.listen = deny;
tls.connect = deny;
syncBuiltinESMExports();
globalThis[Symbol.for('msb.reference.networkBlocked')] = true;
