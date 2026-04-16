# Recap AI

Prima versione locale di Recap AI: registra una visita, trascrive l'audio con AI e genera un riepilogo strutturato.

## Avvio

1. Apri `CONFIGURA_CHIAVE.txt`.
2. Inserisci la tua chiave OpenAI:

```env
OPENAI_API_KEY=sk-...
```

3. Opzionale ma consigliato: cambia la password admin:

```env
ADMIN_PASSWORD=una_password_tua
```

4. Avvia l'app:

```bash
npm run dev
```

5. Apri:

```text
http://localhost:3000
```

Pannello admin:

```text
http://localhost:3000/admin.html
```

## Note

- L'audio viene inviato a OpenAI per la trascrizione.
- L'app non salva audio, trascrizione o riepilogo su disco.
- I clienti e i limiti visite sono salvati in `data/clients.json`.
- Per uso reale con pazienti servono informativa privacy, consenso e impostazioni di sicurezza adeguate.
