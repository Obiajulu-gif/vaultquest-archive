import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

router.get('/google', (req, res) => {
  // Redirect to Google OAuth URL
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth');
});

router.get('/google/callback', async (req, res) => {
  // Exchange authorization code for profile
  const code = req.query.code;
  
  // Fake login/create account logic
  const user = { id: '1', email: 'test@example.com' };
  
  // Issue JWT
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
  
  res.json({ token, user });
});

export default router;
