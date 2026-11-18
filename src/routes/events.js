import { Router } from 'express';
import { asyncHandler } from '../utils/http.js';
import { pastCups, upcomingEvents } from '../services/events.js';

const router = Router();

// Next battle hour / Sunday Cup (with the lobby code once it is open) and recent cup podiums.
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [upcoming, cups] = await Promise.all([upcomingEvents(), pastCups(10)]);
    res.json({ upcoming, cups, serverNow: Date.now() });
  })
);

export default router;
