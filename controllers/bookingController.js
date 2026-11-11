const Booking = require('../models/bookingModel');
const Show = require('../models/showModel');
const redis = require('../config/redis'); // 👈 Import Redis!

// 1. MAKE BOOKING & OCCUPY SEATS (After Payment)
const makeBooking = async (req, res) => {
  let acquiredLocks = []; // Keep track of locks so we can clear them later
  
  try {
    const showId = req.body.showId || req.body.show;
    const selectedSeats = req.body.selectedSeats || req.body.seats;
    const { totalAmount, transactionId } = req.body;

    // 🎯 THE ONLY CHANGE: Safely grab userId from all possible places our new middleware might put it
    const userId = req.userId || req.user?.userId || req.user?._id || req.user?.id || req.body?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User ID not found. Please log in again."
      });
    }
    
    if (!showId || !selectedSeats || selectedSeats.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Show ID and selected seats are required."
      });
    }

    // ==========================================
    // 🛡️ STEP 1: VERIFY REDIS ATOMIC SEAT LOCKS
    // ==========================================
    const lockCheck = await redis.verifyOrAcquireSeatLocks(showId, selectedSeats, userId, 120);
    if (!lockCheck.success) {
      return res.status(409).json({
        success: false,
        message: lockCheck.message || "One or more selected seats are currently being booked by someone else."
      });
    }

    // ==========================================
    // 💾 STEP 2: MONGODB DATABASE OPERATIONS
    // ==========================================

    // Fetch the specific Show document
    const show = await Show.findById(showId);
    if (!show) {
      await redis.releaseSeatLocks(showId, selectedSeats, userId);
      return res.status(404).json({ success: false, message: "Showtime not found." });
    }

    // Check if any selected seats are already booked for this specific date/show
    const alreadyBooked = selectedSeats.some(seat => show.bookedSeats?.includes(seat));
    if (alreadyBooked) {
      await redis.releaseSeatLocks(showId, selectedSeats, userId);
      return res.status(400).json({
        success: false,
        message: "One or more selected seats are already booked. Please choose other seats."
      });
    }

    // Create the Booking Record
    const newBooking = new Booking({
      show: showId,
      user: userId, 
      seats: selectedSeats,
      totalAmount,
      transactionId
    });

    await newBooking.save();

    // 🎯 PERMANENT SEAT OCCUPATION: Push seats into Show document's bookedSeats array
    await Show.findByIdAndUpdate(showId, {
      $push: { bookedSeats: { $each: selectedSeats } }
    });

    // ==========================================
    // 🧹 STEP 3: CLEANUP REDIS LOCKS & SUCCESS
    // ==========================================
    // The seats are safely in MongoDB, so we can delete the temporary Redis locks!
    await redis.releaseSeatLocks(showId, selectedSeats, userId);

    return res.status(201).json({
      success: true,
      message: "Booking confirmed!",
      data: newBooking
    });

  } catch (error) {
    console.error("Booking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
// 2. GET BOOKINGS FOR LOGGED-IN USER
// 2. GET BOOKINGS FOR LOGGED-IN USER
const getUserBookings = async (req, res) => {
  try {
    // 🎯 1. Grab the ID from the URL parameter first!
    let userId = req.params.userId;

    // Fallback: If URL parameter is missing, check the auth token
    if (!userId || userId === 'undefined') {
      if (req.user && req.user._id) userId = req.user._id.toString();
      else if (req.user && req.user.id) userId = req.user.id.toString();
      else if (req.userId) userId = req.userId.toString();
    }

    if (!userId || userId === 'undefined') {
      return res.status(401).json({ success: false, message: "Auth Error: User ID not found." });
    }

    // 🎯 2. Populate show -> movie and show -> theater
    const bookings = await Booking.find({ user: userId })
      .populate({
        path: 'show',
        populate: [
          { path: 'movie', select: 'title posterUrl duration' },
          { path: 'theater', select: 'name city address' }
        ]
      })
      .sort({ createdAt: -1 }); // Most recent first

    return res.status(200).json({
      success: true,
      data: bookings
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
// 3. CANCEL BOOKING & FREE UP SEATS (With Expiration Check)
const cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user?._id || req.body.userId;

    if (!bookingId) {
      return res.status(400).send({
        success: false,
        message: 'Booking ID is required.',
      });
    }

    // A. Find Booking
    const booking = await Booking.findById(bookingId).populate('show');
    if (!booking) {
      return res.status(404).send({
        success: false,
        message: 'Booking record not found.',
      });
    }

    // B. Check Ownership
    if (userId && booking.user.toString() !== userId.toString()) {
      return res.status(403).send({
        success: false,
        message: 'Unauthorized: You can only cancel your own bookings.',
      });
    }

    // C. Check if already cancelled
    if (booking.status === 'CANCELLED') {
      return res.status(400).send({
        success: false,
        message: 'This booking has already been cancelled.',
      });
    }

    // D. ⏰ EXPIRATION CHECK: Ensure show has not already passed
    const show = booking.show;
    if (show && show.date) {
      const showDate = new Date(show.date);
      const now = new Date();

      if (showDate < now.setHours(0, 0, 0, 0)) {
        return res.status(400).send({
          success: false,
          message: 'Cannot cancel tickets for a show that has already expired or ended.',
        });
      }
    }

    // E. 🪑 FREE UP SEATS: Remove booked seats from the Show document
    if (show) {
      await Show.findByIdAndUpdate(show._id, {
        $pull: { bookedSeats: { $in: booking.seats } },
      });
    }

    // F. Update Booking Status to CANCELLED
    booking.status = 'CANCELLED';
    await booking.save();

    return res.status(200).send({
      success: true,
      message: '🎟️ Booking cancelled successfully! Seats are now freed up.',
      data: booking,
    });
  } catch (error) {
    console.error('Error in cancelBooking:', error);
    return res.status(500).send({
      success: false,
      message: error.message || 'Server error while cancelling booking.',
    });
  }
};

module.exports = {
  makeBooking,
  getUserBookings,
  cancelBooking,
};