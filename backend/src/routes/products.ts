import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

router.get('/products', async (req, res) => {
  const { page = 1, limit = 10, categoryId, minPrice, maxPrice } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const where: any = {};
  if (categoryId) {
    where.categoryId = String(categoryId);
  }
  if (minPrice || maxPrice) {
    where.price = {};
    if (minPrice) where.price.gte = Number(minPrice);
    if (maxPrice) where.price.lte = Number(maxPrice);
  }

  // Optimized query with included images to prevent N+1
  const products = await prisma.product.findMany({
    where,
    skip,
    take,
    include: {
      images: true, // Prevents N+1 query problem for product images
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  res.json({ products });
});

export default router;
