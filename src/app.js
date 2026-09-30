const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// public/ sits next to src/ (one level above this file)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // correct client IPs (rate limiting, audit log) behind Vercel / Nginx / Render
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true, // scripts/styles/fonts/images must come from this server: no inline <script>, no CDNs
    directives: {
      // Only force https in production; on plain http (localhost / LAN testing) it would break asset loading
      'upgrade-insecure-requests': isProd ? [] : null,
    },
  },
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Frontend: /login -> public/login.html, / -> public/index.html, /css/..., /js/..., /img/...
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
