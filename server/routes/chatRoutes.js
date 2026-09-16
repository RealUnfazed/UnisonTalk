const express = require('express');
const chatController = require('../controllers/chatController');
const { uploadAttachment, getAttachmentBytes } = require('../controllers/uploadController');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.use(requireAuth); // every route below requires a logged-in session

router.get('/chats', chatController.listChats);
router.post('/chats/private', chatController.createPrivateChat);
router.post('/chats/group', chatController.createGroupChat);
router.get('/chats/:chatId/messages', chatController.getMessages);

router.get('/users/search', chatController.searchUsers);

router.post('/upload', upload.single('file'), uploadAttachment);
router.get('/attachments/:filename', getAttachmentBytes);

module.exports = router;
