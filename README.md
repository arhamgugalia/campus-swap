# Campus Swap
A simple campus marketplace (OLX-style). Node.js + Express + SQLite3 + plain HTML/JS.

## Run
    npm install
    npm start
Open http://localhost:3000

## Options (environment variables)
- PORT — default 3000
- SESSION_SECRET — set a long random string in production
- ALLOWED_DOMAIN — e.g. `college.edu` to allow only college emails

## Features
Email/password signup & login, post items with photo, search & category filter,
seller contact visible to logged-in users, mark sold/relist, delete, "My listings".
Data is stored in campus.db (created automatically). Uploaded photos go in /uploads.

## v2 additions
Item detail page for buyers, buy/offer requests with seller Accept/Decline (accepting marks the item sold),
wishlist, sort + price filters, condition field, view counter, category chips, redesigned UI.
Upgrading from v1: just keep your old campus.db – tables/columns are migrated automatically.
