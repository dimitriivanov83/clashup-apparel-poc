# ClashUp Connected Apparel — POC V2

Multi-user, auth, QR unique par patch, back-office admin.

## Déployer sur Render.com (gratuit, 5 min)

### 1. Push sur GitHub

```bash
cd poc-apparel-live
git init
git add .
git commit -m "ClashUp Apparel POC V2"
git remote add origin https://github.com/TON-USERNAME/clashup-apparel-poc.git
git push -u origin main
```

### 2. Créer le service sur Render

1. [render.com](https://render.com) → Sign up (gratuit)
2. **New → Web Service** → connecte ton repo GitHub
3. Settings :
   - **Name**: `clashup-apparel`
   - **Runtime**: `Node`
   - **Build Command**: _(vide)_
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
4. **Environment Variables** (optionnel) :
   - `ADMIN_PASS` = ton mot de passe admin custom (défaut: `clashup2024`)
5. **Deploy**

URL live : `https://clashup-apparel.onrender.com`

### 3. Tester en live

**Toi (admin)** : `https://ton-url.onrender.com/admin`

**Tes potes** : `https://ton-url.onrender.com` → login avec compte démo

**Scanner** : scanner le QR affiché sur le tel d'un pote

## Comptes démo

| Pseudo | Mot de passe |
|--------|-------------|
| max_la_menace | clash1 |
| sarah_clash | clash2 |
| leo_punch | clash3 |
| nina_fire | clash4 |
| alex_boom | clash5 |

## Stack

- **Serveur** : Node.js pur (zero deps)
- **Frontend** : HTML/CSS/JS vanilla (PWA)
- **Auth** : SHA-256 tokens in-memory
- **Storage** : In-memory (reset au redeploy)

## Local

```bash
node server.js
# → http://localhost:3000
# → Admin: http://localhost:3000/admin
```
