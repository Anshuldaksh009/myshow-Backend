const Razorpay = require('razorpay');
const redisClient = require('../config/redis');
const Show = require('../models/showModel');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const createOrder = async (req, res) => {
  let acquiredLockSeats = [];
  try {
    const { amount, showId, seats } = req.body;

    // Smartly find user ID regardless of how auth middleware attaches it
    let userId;
    if (req.user && req.user._id) userId = req.user._id.toString();
    else if (req.user && req.user.id) userId = req.user.id.toString();
    else if (req.userId) userId = req.userId.toString();
    else if (req.body.userId) userId = req.body.userId.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Auth Error: User ID not found. Please log in again."
      });
    }

    if (!showId || !Array.isArray(seats) || seats.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Show ID and selected seats are required."
      });
    }

    // 1. Verify show exists & seats are not already booked in MongoDB
    const show = await Show.findById(showId);
    if (!show) {
      return res.status(404).json({ success: false, message: "Show not found." });
    }

    const alreadyBooked = seats.some((seat) => show.bookedSeats?.includes(seat));
    if (alreadyBooked) {
      return res.status(400).json({
        success: false,
        message: "One or more selected seats have already been booked. Please choose different seats."
      });
    }

    // 2. 🛡️ ATOMIC REDIS LOCKING (NX EX 600 = 10 mins)
    const lockResult = await redisClient.acquireSeatLocks(showId, seats, userId, 600);
    if (!lockResult.success) {
      return res.status(409).json({
        success: false,
        message: lockResult.message
      });
    }

    acquiredLockSeats = lockResult.lockedSeats;

    // 3. If ALL locks succeeded, create the Razorpay order
    const options = {
      amount: Math.round(amount * 100), // ₹1 = 100 paise
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    // If Razorpay order creation fails, release the locks immediately
    if (acquiredLockSeats.length > 0) {
      await redisClient.releaseSeatLocks(req.body.showId, acquiredLockSeats);
    }
    console.error("Razorpay Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 4. Release locks if user closes the payment popup without paying
const cancelLock = async (req, res) => {
  try {
    const { showId, seats } = req.body;
    let userId = req.user?._id || req.user?.id || req.userId || req.body?.userId;

    await redisClient.releaseSeatLocks(showId, seats, userId);
    return res.status(200).json({ success: true, message: "Seat locks released successfully." });
  } catch (error) {
    console.error("Lock Release Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createOrder, cancelLock };
