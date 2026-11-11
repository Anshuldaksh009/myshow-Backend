const User = require('../models/userModel');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config(); 

const OTP = require('../models/otpModel');
const nodemailer = require('nodemailer');
const { Resend } = require('resend'); // 👈 Using Resend API (Render-friendly, bypasses SMTP blocks)

// Initialize Resend with your API key from environment variables
const resend = new Resend(process.env.RESEND_API_KEY);

// Initialize Nodemailer transporter with Gmail credentials
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 10000,
  socketTimeout: 10000,
});

// ==========================================
// 1. SEND OTP CONTROLLER
// ==========================================
exports.sendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).send({ success: false, message: 'Email is required.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).send({ success: false, message: 'Email is already registered. Please log in.' });
    }

    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();

    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(generatedOtp, salt);

    await OTP.deleteMany({ email: email.toLowerCase() });

    await OTP.create({
      email: email.toLowerCase(),
      otp: hashedOtp,
    });

    console.log(`🔑 [OTP] Verification code for ${email}: ${generatedOtp}`);

    let emailSent = false;
    let lastError = null;

    // 1. Try Nodemailer first (delivers to ANY email address using Gmail App Password)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        await transporter.sendMail({
          from: `"BookMyShow" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: '🔑 Your Verification Code for BookMyShow',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h2>BookMyShow Email Verification</h2>
              <p>Your OTP verification code is:</p>
              <h1 style="color: #dc3545; letter-spacing: 4px;">${generatedOtp}</h1>
              <p>This code will expire in 5 minutes.</p>
            </div>
          `,
        });
        emailSent = true;
        console.log(`✅ Email sent successfully via Nodemailer to ${email}`);
      } catch (nmErr) {
        lastError = nmErr;
        console.warn('⚠️ Nodemailer failed, trying Resend fallback:', nmErr.message);
      }
    }

    // 2. If Nodemailer didn't succeed, try Resend API
    if (!emailSent && process.env.RESEND_API_KEY) {
      const data = await resend.emails.send({
        from: 'BookMyShow <onboarding@resend.dev>',
        to: [email],
        subject: '🔑 Your Verification Code for BookMyShow',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>BookMyShow Email Verification</h2>
            <p>Your OTP verification code is:</p>
            <h1 style="color: #dc3545; letter-spacing: 4px;">${generatedOtp}</h1>
            <p>This code will expire in 5 minutes.</p>
          </div>
        `,
      });

      if (data.error) {
        console.error('❌ Resend API Error:', data.error.message);
        lastError = new Error(data.error.message);
      } else {
        emailSent = true;
        console.log('✅ Email sent successfully via Resend:', data);
      }
    }

    if (!emailSent && lastError) {
      throw lastError;
    }

    return res.status(200).send({
      success: true,
      message: `OTP sent successfully to ${email}`,
    });
  } catch (error) {
    console.error('❌ EMAIL ERROR DETAILS:', error);

    return res.status(500).send({
      success: false,
      message: error.message || 'Failed to send OTP email.',
    });
  }
};

// ==========================================
// 2. REGISTER WITH OTP CONTROLLER
// ==========================================
exports.registerWithOtp = async (req, res) => {
  try {
    const { name, email, password, otp, role } = req.body;

    if (!name || !email || !password || !otp) {
      return res.status(400).send({ success: false, message: 'All fields including OTP are required.' });
    }

    // Find OTP record
    const otpRecord = await OTP.findOne({ email: email.toLowerCase() });
    if (!otpRecord) {
      return res.status(400).send({
        success: false,
        message: 'OTP has expired or was not requested. Click "Send OTP" again.',
      });
    }

    // Verify OTP match
    const isOtpValid = await bcrypt.compare(otp, otpRecord.otp);
    if (!isOtpValid) {
      return res.status(400).send({ success: false, message: 'Invalid OTP entered. Please try again.' });
    }

    // Hash user password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save user to MongoDB
    const newUser = new User({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      role: role || 'user',
    });

    await newUser.save();

    // Clear used OTP record
    await OTP.deleteOne({ _id: otpRecord._id });

    return res.status(201).send({
      success: true,
      message: '🎉 Account created successfully! You can now log in.',
    });
  } catch (error) {
    console.error('Error in registerWithOtp:', error);
    return res.status(500).send({
      success: false,
      message: error.message || 'Server error during registration.',
    });
  }
};

// ==========================================
// 3. STANDARD REGISTER CONTROLLER
// ==========================================
exports.register = async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        console.log(req.body);
        
        const userExists = await User.findOne({ email });
        
        if (userExists) {
            return res.status(400).send({ 
                success: false, 
                message: "This email is already registered. Please sign in instead." 
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            name,
            email,
            password: hashedPassword,
            role
        });

        await newUser.save();

        res.status(201).send({ 
            success: true, 
            message: "User registered successfully! You can now log in." 
        });

    } catch (error) {
        res.status(500).send({ success: false, message: error.message });
    }
};

// ==========================================
// 4. LOGIN CONTROLLER
// ==========================================
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).send({ success: false, message: "User not found. Please register first." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).send({ success: false, message: "Invalid email or password." });
        }

        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        console.log("authController working");
        
        return res.status(200).send({
            success: true,
            message: 'Login successful',
            data: token,
            user: {
              _id: user._id,
              name: user.name,
              email: user.email,
              role: user.role
            }
        });
    } catch (error) {
        res.status(500).send({ success: false, message: error.message });
    }
};