import { Router } from 'express';
import Stripe from 'stripe';

const router = Router();
// Ensure the Stripe secret key is securely loaded from environment variables
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-06-20',
});

router.post('/create-intent', async (req, res) => {
  try {
    const { items } = req.body;
    
    // Calculate the order total
    let totalAmount = 0;
    if (items && Array.isArray(items)) {
      totalAmount = items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    }
    
    if (totalAmount <= 0) {
      return res.status(400).json({ error: 'Invalid order amount' });
    }

    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      client_secret: paymentIntent.client_secret,
    });
  } catch (error: any) {
    // Add basic error handling for declined cards or API timeouts
    console.error('Stripe error:', error.message);
    res.status(500).json({
      error: 'Failed to create payment intent',
      details: error.message
    });
  }
});

export default router;
