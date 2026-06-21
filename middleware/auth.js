// middleware/auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-render-env-vars';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is not set in environment variables — using an insecure default.');
  console.warn('⚠️ Set a real JWT_SECRET in Render → Environment before relying on this in production.');
}

// ── Role → permission matrix ──
// Every permission check in the app reduces to one of these named permissions,
// rather than routes hardcoding role names — makes the rules auditable in one place
// and easy to extend without touching every route file again.
const ROLES = ['admin', 'data_entry', 'crm', 'mis', 'ea'];

const PERMISSIONS = {
  admin: {
    manage_users: true, manage_settings: true, send_whatsapp: true,
    edit_data: true, delete_data: true, view_swa: true, edit_swa: true,
    view_reports: true, view_data: true,
  },
  data_entry: {
    manage_users: false, manage_settings: false, send_whatsapp: false,
    edit_data: true, delete_data: false, view_swa: true, edit_swa: true,
    view_reports: false, view_data: true,
  },
  crm: {
    manage_users: false, manage_settings: false, send_whatsapp: true,
    edit_data: true, delete_data: true, view_swa: false, edit_swa: false,
    view_reports: false, view_data: true,
  },
  mis: {
    manage_users: false, manage_settings: false, send_whatsapp: false,
    edit_data: false, delete_data: false, view_swa: true, edit_swa: false,
    view_reports: true, view_data: true,
  },
  ea: {
    manage_users: false, manage_settings: false, send_whatsapp: false,
    edit_data: false, delete_data: false, view_swa: true, edit_swa: false,
    view_reports: true, view_data: true,
  },
};

function can(role, permission) {
  const roleDef = PERMISSIONS[role];
  return !!(roleDef && roleDef[permission]);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
}

// Use after requireAuth: requirePermission('manage_settings') etc. Returns 403 with
// a clear message naming the permission, rather than a generic "forbidden" — useful
// both for the person hitting the wall and for diagnosing access issues later.
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    if (!can(req.user.role, permission)) {
      return res.status(403).json({ error: `Your role (${req.user.role}) does not have permission to do this (${permission}).` });
    }
    next();
  };
}

module.exports = { requireAuth, requirePermission, can, ROLES, PERMISSIONS, JWT_SECRET };
