import { Elysia as Server } from 'elysia';
import { initTRPC as init } from '@trpc/server';

const app = new Server();
app.get('/ready', () => 'private-response');
app.handle(new Request('https://example.invalid/ready'));

const otherApp = new Server();
otherApp.get('/ready', () => 'separate-response');
otherApp.handle(new Request('https://elsewhere.invalid/ready'));

const t = init.create();
const router = t.router({ ready: t.procedure.query(() => 'private-result'), save: t.procedure.mutation(input => input) });
const caller = router.createCaller({});
caller.ready();
caller.save('private-input');

fetch('https://example.invalid/ready');
remote.ready();
