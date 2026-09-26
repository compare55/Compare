# GitHub + Render + Netlify setup

## 1. GitHub
Upload the contents of this folder to the root of your GitHub repository:
- `color-frontend/`
- `color-backend/`
- `DEPLOYMENT.md`

Do not upload secrets.

## 2. Render backend
Create a **Web Service** from the same GitHub repo.
- Root Directory: `color-backend`
- Build Command: `npm install`
- Start Command: `npm start`

Create a Render PostgreSQL database and connect its **Internal Database URL** as:
- `DATABASE_URL`
- `ADMIN_KEY` = a strong private admin secret
- `NODE_ENV` = `production`

The backend creates its database tables on startup.

## 3. Netlify frontend
Create a Netlify site from the same GitHub repo.
- Base directory: `color-frontend`
- Publish directory: `color-frontend`
- Build command: leave empty

After the Render backend is deployed, edit `color-frontend/config.js`:
`window.GAME_API_URL = "https://YOUR-RENDER-SERVICE.onrender.com";`

Commit/push that change. Netlify will redeploy.

## 4. URLs
- Game: `https://YOUR-NETLIFY-SITE.netlify.app/`
- Admin: `https://YOUR-NETLIFY-SITE.netlify.app/admin`
- Backend health: `https://YOUR-RENDER-SERVICE.onrender.com/api/health`

## 5. Important
The Netlify frontend must point to the Render backend URL. Do not put `DATABASE_URL` or `ADMIN_KEY` in the frontend/config.js.
SMS OTP is not included.
