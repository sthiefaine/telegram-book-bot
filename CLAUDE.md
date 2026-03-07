# Telegram Book Bot

Bot Telegram pour rechercher des livres via Prowlarr.

## Stack

- **Bot** : Node.js + Telegraf (v4)
- **Search engine** : Prowlarr (API REST)
- **Déploiement** : Docker Compose sur Coolify (Hetzner)

## Architecture

```
telegram-book-bot/
├── docker-compose.yml      # Prowlarr + bot
├── .env                    # Variables d'environnement (non versionné)
├── .env.example            # Template des variables
└── bot/
    ├── Dockerfile          # Image Node 20 Alpine
    ├── package.json
    └── src/
        ├── index.js        # Bot Telegram (commandes, handlers)
        └── prowlarr.js     # Client API Prowlarr
```

## Variables d'environnement

- `TELEGRAM_BOT_TOKEN` : Token du bot (via @BotFather)
- `PROWLARR_API_KEY` : Clé API Prowlarr (Settings > General)

## Comment ça marche

1. L'utilisateur envoie `/search <titre>` ou tape directement un titre
2. Le bot interroge l'API Prowlarr (`/api/v1/search?query=...&type=book`)
3. Les résultats sont triés par seeders et affichés avec des boutons inline
4. L'utilisateur clique sur un bouton pour obtenir le lien de téléchargement

## Prowlarr

- URL interne Docker : `http://prowlarr:9696`
- Interface web : port 9696
- Les indexeurs de livres/ebooks doivent être configurés manuellement dans l'UI Prowlarr

## Déploiement sur Coolify

1. Push le repo sur GitHub
2. Dans Coolify, créer un service "Docker Compose" pointant vers le repo
3. Ajouter les variables d'env (`TELEGRAM_BOT_TOKEN`, `PROWLARR_API_KEY`)
4. Déployer

## Dev local

```bash
cp .env.example .env
# Remplir les variables dans .env
docker compose up -d
```

## TODO

- [ ] Ajouter un système de cache pour éviter les recherches répétées
- [ ] Permettre de filtrer par format (epub, pdf, mobi)
- [ ] Ajouter la pagination si plus de 10 résultats
- [ ] Restreindre l'accès au bot (whitelist d'utilisateurs Telegram)
- [ ] Envoyer le fichier directement dans Telegram si assez petit (<50MB)
