Just a proxyv


create .env with :
```env
PORT=5657
SECRET_KEY=...
DEBUG=true
```

Start :
```bash
npx pm2 restart cors-proxy
```

check logs:

```bash
npx pm2 flush cors-proxy
npx pm2 logs
npx pm2 logs cors-proxy --lines 20
```


check whats run :
```bash
npx pm2 list
npx pm2 monit
```