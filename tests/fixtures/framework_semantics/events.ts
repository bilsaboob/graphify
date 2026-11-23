import { EventEmitter as Emitter } from 'node:events';

const listeners = new Emitter();
listeners.on('ready', value => consume(value));
listeners.on('ready', value => consumeAgain(value));
listeners.emit('ready', payload);

const separate = new Emitter();
separate.emit('ready', otherPayload);
