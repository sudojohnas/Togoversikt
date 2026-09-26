# Togoversikt
Togoversikt.no vise tog og togtider

## Cloudflare-versjon

Dette repoet inneholder Cloudflare-versjonen av Togoversikt.no.

- Frontend og statiske filer serveres av Cloudflare Workers Assets.
- `/api/*` proxier Bane NOR SIRI og Entur.
- `main` er produksjonsbranch for Cloudflare Builds.
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Original FastAPI/Docker-versjon beholdes separat på Debian-serveren og ligger ikke i dette repoet.
