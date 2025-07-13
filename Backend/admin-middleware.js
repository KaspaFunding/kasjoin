// Simple admin middleware for API key-based role authentication

// Example: set these in your .env file
// ADMIN_API_KEY=your_admin_key
// MODERATOR_API_KEY=your_moderator_key

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'admin-secret';
const MODERATOR_API_KEY = process.env.MODERATOR_API_KEY || 'moderator-secret';

const apiKeys = {
  [ADMIN_API_KEY]: { role: 'admin' },
  [MODERATOR_API_KEY]: { role: 'moderator' },
};

// Looks up user by API key
async function getUserByApiKey(apiKey) {
  if (!apiKey) throw new Error('No API key provided');
  const user = apiKeys[apiKey];
  if (!user) throw new Error('Invalid API key');
  return { ...user, apiKey };
}

// Middleware: require a certain role (admin or moderator)
function requireRole(role) {
  return async function (req, res, next) {
    try {
      const apiKey = req.headers['x-admin-key'];
      const user = await getUserByApiKey(apiKey);
      // Allow if user has required role or is admin
      if (user.role === role || user.role === 'admin') {
        req.user = user;
        return next();
      }
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized: ' + (e.message || 'Invalid API key') });
    }
  };
}

module.exports = { requireRole, getUserByApiKey }; 