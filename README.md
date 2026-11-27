# ruhua30s

## Deploy with npm

Requires Node.js 20+.

```bash
git clone https://github.com/shixyuu/ruhua30s.git
cd ruhua30s
npm install
npm run build
PORT=3000 npm start
```

Then open `http://<host>:3000/`. Put the server behind a reverse proxy with HTTPS (e.g. Caddy or nginx), since browsers only allow camera and microphone access on HTTPS.

Optional environment variables:

- `PORT` (default `3000`), `HOST`
- `ADMIN_TOKEN`: if set, `/admin` requires `?token=<value>`
