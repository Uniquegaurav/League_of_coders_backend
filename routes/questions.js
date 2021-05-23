import express from 'express'
import {likeQuestion} from '../controllers/questions.js';
const router  = express.Router();
import auth from '../middleware/auth.js'

// like Question router
router.patch('/:id/likeQuestion',auth,likeQuestion);
export default router;