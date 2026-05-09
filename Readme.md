Just a proxyv


create .env with :
```env
PORT=5657
SECRET_KEY=...
```

Start :
```bash
npx pm2 restart cors-proxy
```

check logs:

```bash
npx pm2 logs
```


check whats run :
```bash
npx pm2 list
npx pm2 monit
```