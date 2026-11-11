const Show = require("../models/showModel.js");
const Theater = require("../models/theaterModel.js");
const redisClient = require("../config/redis.js");

// 1. ADD SHOW (Generates individual show documents for each date)
const addShow = async (req, res) => {
  try {
    const { movie, theater, date, endDate, time, ticketPrice, name, totalSeats } = req.body;

    if (!movie || !theater || !date || !time) {
      return res.status(400).send({ success: false, message: 'Missing required fields.' });
    }

    // 🛡️ Timezone-Proof Date Parsing
    const parseDateStrict = (dateString) => {
      if (!dateString) return null;
      const [year, month, day] = dateString.split('T')[0].split('-');
      return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
    };

    let currentDate = parseDateStrict(date);
    const lastDate = parseDateStrict(endDate) || parseDateStrict(date); 

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const strictToday = parseDateStrict(todayStr);

    if (lastDate < strictToday) {
      return res.status(400).send({ success: false, message: 'Cannot schedule shows for past dates.' });
    }

    let seatsCount = totalSeats;
    if (!seatsCount) {
      const theaterDoc = await Theater.findById(theater).lean();
      seatsCount = theaterDoc?.totalSeats || 80;
    }

    const showsToCreate = [];

    // 🎯 The Loop - Iterates day by day
    while (currentDate <= lastDate) {
      if (currentDate >= strictToday) {
        showsToCreate.push({
          name: name || 'Screening Slot',
          movie,
          theater,
          date: new Date(currentDate.getTime()), // 👈 Unique date for this specific document!
          endDate: new Date(lastDate.getTime()), // Keeps the original range end date
          time,
          ticketPrice: Number(ticketPrice),
          totalSeats: seatsCount,
          bookedSeats: [],                        // Fresh seat array for this day
          isActive: true
        });
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 1); // Safely increment to the next day
    }

    if (showsToCreate.length === 0) {
      return res.status(400).send({ success: false, message: 'No valid future dates found.' });
    }

    // Insert all documents at once
    const createdShows = await Show.insertMany(showsToCreate);

    console.log(`✅ SUCCESS: Generated and saved ${createdShows.length} separate show documents!`);

    return res.status(201).send({
      success: true,
      message: `Successfully generated ${createdShows.length} individual showtime(s)!`,
      data: createdShows
    });

  } catch (error) {
    console.error("Add Show Error:", error);
    return res.status(500).send({ success: false, message: error.message });
  }
};

// 2. GET SHOWS BY CITY & MOVIE (Optimized with Database-level City Filtering & .lean())
const getShowsByCityAndMovie = async (req, res) => {
  try {
    const { movie, city, date } = req.query;

    if (!movie || !city) {
      return res.status(400).send({ success: false, message: 'Movie ID and City are required.' });
    }

    // 1. Find matching theaters in the given city first to utilize database indexes efficiently
    const matchingTheaters = await Theater.find({
      city: { $regex: new RegExp(`^${city.trim()}$`, 'i') },
      isActive: true
    }).select('_id').lean();

    const theaterIds = matchingTheaters.map(t => t._id);

    if (theaterIds.length === 0) {
      return res.status(200).send({ success: true, count: 0, data: [] });
    }

    let filter = { 
      movie: movie, 
      theater: { $in: theaterIds },
      isActive: { $ne: false } 
    };

    if (date && date !== 'undefined' && date !== 'null') {
      const targetDate = new Date(date);
      if (!isNaN(targetDate.getTime())) {
        const startOfDay = new Date(date);
        startOfDay.setUTCHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setUTCHours(23, 59, 59, 999);

        filter.date = { $gte: startOfDay, $lte: endOfDay };
      }
    } else {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      filter.date = { $gte: today };
    }

    // 2. Query shows using optimized indexes and .lean()
    const shows = await Show.find(filter)
      .populate('movie')
      .populate('theater')
      .sort({ date: 1, time: 1 })
      .lean(); // 👈 Blazing fast performance optimization

    return res.status(200).send({
      success: true,
      count: shows.length,
      data: shows,
    });
  } catch (error) {
    console.error('Error in getShowsByCityAndMovie:', error);
    return res.status(500).send({ success: false, message: error.message });
  }
};

// 3. GET ALL SHOWS FOR ADMIN (Optimized with .lean())
const getAllShows = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const shows = await Show.find({
      $or: [
        { date: { $gte: startOfToday } },
        { endDate: { $gte: startOfToday } },
        { date: { $exists: false } }
      ]
    })
    .populate('movie', 'title posterUrl language') 
    .populate('theater', 'name city address')       
    .sort({ date: 1, time: 1 })                
    .lean(); // 👈 Skips Mongoose document hydration

    return res.status(200).json({
      success: true,
      count: shows.length,
      data: shows
    });
  } catch (error) {
    console.error("Error in getAllShows:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 4. SOFT / HARD DELETE SHOW
const deleteShow = async (req, res) => {
  try {
    const id = req.params.showId || req.params.id;

    if (!id) {
      return res.status(400).send({ success: false, message: 'Show ID parameter is missing.' });
    }

    const show = await Show.findById(id);
    if (!show) {
      return res.status(404).send({ success: false, message: 'Show not found.' });
    }

    await Show.findByIdAndDelete(id);

    return res.status(200).send({ success: true, message: 'Showtime deleted successfully.' });
  } catch (error) {
    console.error('Error in deleteShow:', error);
    return res.status(500).send({ success: false, message: error.message });
  }
};

// 5. GET SHOW BY ID (Optimized with .lean() & includes temporary Redis locks)
const getShowById = async (req, res) => {
  try {
    const reqId = req.params.id;
    if (!reqId) {
      return res.status(400).send({ success: false, message: "Show ID is required" });
    }

    const show = await Show.findById(reqId)
      .populate("movie")
      .populate("theater")
      .lean(); // 👈 High performance read operation

    if (!show) {
      return res.status(404).send({ success: false, message: "Show not found" });
    }

    // 🛡️ Fetch any active Redis seat locks for this show
    const lockedSeats = await redisClient.getLockedSeats(reqId);

    // Merge permanently booked seats from MongoDB + temporary locked seats from Redis
    const allUnavailableSeats = Array.from(new Set([
      ...(show.bookedSeats || []),
      ...(lockedSeats || [])
    ]));

    return res.status(200).send({
      success: true,
      data: {
        ...show,
        bookedSeats: allUnavailableSeats,
        temporaryLockedSeats: lockedSeats || []
      }
    });
  } catch (err) {
    console.error("Error in getShowById:", err);
    return res.status(500).send({ success: false, message: err.message });
  }
};

module.exports = {
  deleteShow,
  addShow,
  getAllShows,
  getShowById,
  getShowsByCityAndMovie
};