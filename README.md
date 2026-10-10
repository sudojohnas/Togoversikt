# Togoversikt

[Togoversikt.no](https://togoversikt.no) viser tog, togtider, passeringer og
trafikkstatus fra Bane NOR SIRI, Togkart og daglige rutegrafer.

## Cloudflare-versjon

Dette repoet inneholder Cloudflare-versjonen av Togoversikt.no.

- Frontend og statiske filer serveres av Cloudflare Workers Assets.
- `/api/*` proxier Bane NOR SIRI og Entur.
- `main` er produksjonsbranch for Cloudflare Builds.
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Original FastAPI/Docker-versjon beholdes separat på Debian-serveren og ligger ikke i dette repoet.

## Lokal utvikling

Krever Node.js 22 eller nyere.

```sh
npm ci
npm test
npm run dev
```

`npm run check` kjører tester, bygger frontend, kontrollerer at den genererte
`public/app.js` er oppdatert og kjører sikkerhetskontroll av avhengighetene.

## Produksjon og rollback

Push til `main` bygges og deployes av Cloudflare Builds. GitHub Actions kjører
tester, bygg, audit og Wrangler dry-run. Tidligere Worker-versjoner kan finnes med
`npx wrangler deployments list` og rulles tilbake fra Cloudflare-dashboardet.

`/health` viser Worker-versjon og om ntfy-varsling er konfigurert. Endepunktet
bekrefter at Worker kjører; overvåk også et representativt API-kall eksternt.

## Lagring

Bindingen `ROUTE_GRAPHS` brukes til rutegrafer og Togkart-arkiv. Alle nye
verdier får 30 dagers utløpstid. Parserformatet inngår i nøkkelnavnet, og gamle
parserformater skal slettes etter utrulling av et nytt format.

## Varsling med ntfy

Worker-hemmeligheten `NTFY_TOPIC_URL` inneholder hele publish-URL-en, for
eksempel `https://ntfy.sh/en-lang-tilfeldig-topic`. `NTFY_TOKEN` er valgfri og
brukes som Bearer-token hvis topicen ligger på en autentisert ntfy-server.

Cron-feil og uventede API-feil sendes til ntfy. Like feil dempes i 15 minutter
med en kortlivet KV-nøkkel for å unngå varslingsstormer.

```sh
printf '%s' 'https://ntfy.sh/topic' | npx wrangler secret put NTFY_TOPIC_URL
```

## Datakilder og feilsøking

- Bane NOR SIRI: stop monitoring, estimated timetable og production timetable.
- Bane NOR Togkart: filtreres i Worker til valgt sted før data sendes til klienten.
- Bane NOR daglige rutegrafer: PDF-er kontrolleres av cron hvert 15. minutt.
- Entur Geocoder: brukes bare til å finne nærmeste jernbanested.

Ved feil: kontroller `/health`, Workers Logs/Issues, siste deploy og ntfy. Alle
datakilder behandles som informative; løsningen er ikke sikkerhetskritisk.
