import express from 'express'
import { createPost, getPost ,updatePost ,deletePost , likePost } from '../controllers/posts.js';
const router  = express.Router();
import auth from '../middleware/auth.js'

router.get('/',getPost);
router.post('/',auth,createPost);
router.patch('/:id' ,auth,updatePost)
router.delete('/:id',auth,deletePost);
router.patch('/:id/likePost',auth,likePost);

export default router;