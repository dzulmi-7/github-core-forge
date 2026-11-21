import { createApp } from './app.ts';
const s = createApp();
s.listen(Number(process.env.PORT ?? 8123), () => console.log('up', (s.address() as any).port));
