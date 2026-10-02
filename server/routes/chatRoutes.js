const express = require('express');
const chatController = require('../controllers/chatController');
const userController = require('../controllers/userController');
const { uploadAttachment, getAttachmentBytes } = require('../controllers/uploadController');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const avatarUpload = require('../middleware/avatarUpload');

const router = express.Router();

router.use(requireAuth); // every route below requires a logged-in session

router.get('/chats', chatController.listChats);
router.post('/chats/private', chatController.createPrivateChat);
router.post('/chats/group', chatController.createGroupChat);
router.get('/chats/:chatId/messages', chatController.getMessages);
router.patch('/chats/:chatId', chatController.updateGroup);
router.post('/chats/:chatId/avatar', avatarUpload.single('file'), chatController.uploadGroupAvatar);

router.get('/users/search', chatController.searchUsers);
router.patch('/users/me', userController.updateProfile);
router.post('/users/me/avatar', avatarUpload.single('file'), userController.uploadAvatar);
router.delete('/users/me/avatar', userController.removeAvatar);

router.post('/upload', upload.single('file'), uploadAttachment);
router.get('/attachments/:filename', getAttachmentBytes);

module.exports = router;
