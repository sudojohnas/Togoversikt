# Togoversikt.no – Cloudflare-versjon

Separat kopi av Togoversikt.no for offentlig drift på Cloudflare Workers. Den opprinnelige FastAPI/Docker-versjonen på Debian ligger i et annet prosjekt og påvirkes ikke av denne varianten.

## Arkitektur

- Cloudflare Workers Static Assets serverer HTML/CSS/JavaScript.
- Worker-koden i `src/index.js` er en lett proxy mot Bane NOR SIRI og Entur.
- XML-parsing skjer i nettleseren, ikke i Worker-en. Dette holder normal API-trafikk innenfor Workers Free sin lave CPU-grense.
- Livevisning bruker primært SIRI SM per valgt stasjon/blokkpost.
- Historiske tider samme dag og fallback-punkter bruker SIRI ET.
- Andre datoer bruker datofiltrert SIRI PT.

## Lokal utvikling

```bash
npm install
npm run dev
```

## Cloudflare Workers Builds

Importer GitHub-repoet i **Workers & Pages → Create application → Import a repository**.

- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/` (tom/standard)

`wrangler.jsonc` er kilde for Worker-navn, statiske assets og API-routing.

## Sikkerhet

Data fra Bane NOR er informasjonsdata. Tjenesten skal ikke brukes som sikkerhetskritisk grunnlag eller som erstatning for gjeldende Bane NOR-prosedyrer, togleder eller godkjente operative systemer.
