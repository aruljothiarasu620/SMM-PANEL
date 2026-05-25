# BoostGram SMM Panel 🚀

A full-featured **Social Media Marketing (SMM) Panel** built with Node.js, Express, and a zero-dependency JSON database. Supports Instagram, YouTube, Facebook, and TikTok services.

## Features

- 🔐 **Google OAuth 2.0 Login** — Sign in with Google
- 💰 **Wallet System** — Razorpay payment integration
- 📦 **Order Management** — Automatic delivery via SMM Provider APIs
- 👑 **Admin Panel** — Full control over users, orders, and services
- 🔄 **Auto-sync** — Automatic order status sync every 5 minutes
- 📱 **Responsive UI** — Dark mode, premium design

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: JSON file-based (zero native dependencies)
- **Payments**: Razorpay
- **SMM Provider**: JustAnotherPanel API (or any compatible API)
- **Auth**: Google Identity Services OAuth 2.0

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/aruljothiarasu620/SMM-MAIN.git
   cd SMM-MAIN
   ```

2. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp backend/.env.example backend/.env
   # Edit .env with your keys
   ```

4. Start the server:
   ```bash
   node server.js
   ```

5. Open **http://localhost:3000** in your browser.

## Environment Variables

| Variable | Description |
|---|---|
| `RAZORPAY_KEY_ID` | Razorpay API Key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay API Secret |
| `SMM_API_URL` | SMM Provider API URL |
| `SMM_API_KEY` | SMM Provider API Key |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `PORT` | Server port (default: 3000) |

## Admin Access

The admin panel is accessible only to users with the admin role. Admin is auto-assigned for configured admin emails.

## License

MIT License — Feel free to use and modify!
