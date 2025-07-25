// index.js (or app.js) for your Node.js Backend

// Load environment variables from .env file
require('dotenv').config();

// Import necessary modules
const express = require('express');
const { Pool } = require('pg'); // PostgreSQL client
const cors = require('cors'); // Middleware for Cross-Origin Resource Sharing
const axios = require('axios'); // For Telegram API

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000; // Use environment port or default to 3000

// --- Database Configuration ---
const sslConfig = process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false } // Required for Render's database
    : false; // For local PostgreSQL (which usually doesn't need SSL)

// --- DEBUGGING: Log DB connection parameters ---
console.log('Attempting to connect to DB with:');
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_DATABASE:', process.env.DB_DATABASE);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SSL Config used:', sslConfig);
console.log('DB_PASSWORD (first 5 chars):', process.env.DB_PASSWORD ? process.env.DB_PASSWORD.substring(0, 5) + '3TEXrlu4o087YHbw3BcUKO4lOik4a2Tn' : 'NOT SET OR EMPTY');
// --- END DEBUGGING ---

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: sslConfig
});

// Test database connection
pool.connect()
    .then(client => {
        console.log('Connected to PostgreSQL database successfully!');
        client.release();
    })
    .catch(err => {
        console.error('Error connecting to PostgreSQL database:', err.message);
    });

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Helper function to format date and time (from code for add.txt) ---
function formatDateTime(date) {
    const d = new Date(date);
    const pad = (n) => n.toString().padStart(2, '0');

    let hours = d.getHours();
    const minutes = pad(d.getMinutes());
    const ampm = hours >= 12 ? 'PM' : 'AM';

    hours = hours % 12;
    hours = hours ? hours : 12; // 12-hour format
    const formattedTime = `${pad(hours)}:${minutes} ${ampm}`;

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formattedTime}`;
}


// --- Telegram Notification Function ---
async function sendTelegramNotification(booking) {
  const formattedDate = formatDateTime(booking.datetime); // Use the new formatDateTime function
  const message = `
🧖 NEW BOOKING !

🧾 Service: ${booking.service}

🧴 Therapy Name: ${booking.therapy_name}

⏱️ Duration: ${booking.duration}

💵 Price: $${booking.price}

👤 Customer: ${booking.name}

📞 Phone: ${booking.phone}

📅 Time: ${formattedDate}

🔔 Please prepare the room and therapist.
`;
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            //parse_mode: 'HTML'
        });
        console.log('✅ Telegram alert sent with service and therapy_name.');
    } catch (error) {
        console.error('❌ Failed to send Telegram alert:', error.message);
    }
}
async function sendTelegramCancellationAlert(booking) {
    const formattedDate = formatDateTime(booking.datetime); // Use the new formatDateTime function
    const message = `
❌ BOOKING CANCELLED

👤 Customer: ${booking.name}

🧴 Service: ${booking.service}

📅 Time: ${formattedDate}

⚠️ This booking has been cancelled.
    `;
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
        });
        console.log(`📣 Telegram cancellation alert sent for ${booking.name}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram cancellation alert:', error.message);
    }
}


// --- API Routes for Bookings ---
app.get('/booking_spa12', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM booking_spa12 ORDER BY datetime DESC;');
        // Apply formatDateTime to each row's datetime before sending
        res.json(result.rows.map(row => ({
            ...row,
            datetime: formatDateTime(row.datetime) // Apply formatting here
        })));
    } catch (err) {
        console.error('Error fetching bookings from booking_spa12 table:', err);
        res.status(500).json({ error: 'Failed to retrieve bookings from the database.' });
    }
});

app.post('/booking_spa12', async (req, res) => {
    const { service, therapyName, duration, price, name, phone, datetime } = req.body;

    if (!service || !duration || !price || !name || !phone || !datetime || !therapyName) {
        return res.status(400).json({ error: 'All booking fields are required.' });
    }

    const cleanPrice = parseFloat(String(price).replace(/[^0-9.]/g, ''));
    const bookingStart = new Date(datetime);
    // Convert duration from string (e.g., "60min") to minutes (60)
    const durationMinutes = parseInt(duration.replace('min', ''));
    const bookingEnd = new Date(bookingStart.getTime() + durationMinutes * 60000); // duration in milliseconds

    try {
        // Get all bookings for this therapist that might overlap
        const conflictCheck = await pool.query(
            `SELECT * FROM booking_spa12
             WHERE therapy_name = $1
             AND datetime >= $2::timestamp - INTERVAL '2 hours'
             AND datetime <= $3::timestamp;`,
            [therapyName, bookingStart.toISOString(), bookingEnd.toISOString()]
        );

        for (let existing of conflictCheck.rows) {
            const existingStart = new Date(existing.datetime);
            const existingDurationMinutes = parseInt(existing.duration.replace('min', ''));
            const existingEnd = new Date(existingStart.getTime() + existingDurationMinutes * 60000);

            // Check for overlap: (StartA < EndB) && (EndA > StartB)
            const overlaps = bookingStart < existingEnd && bookingEnd > existingStart;
            if (overlaps) {
                return res.status(409).json({
                    error: `Therapist ${therapyName} already has a booking from ${formatDateTime(existingStart)} to ${formatDateTime(existingEnd)}. Please choose another time.`
                });
            }
        }

        // No conflicts — insert the booking
        const result = await pool.query(
            `INSERT INTO booking_spa12(service, therapy_name, duration, price, name, phone, datetime)
             VALUES($1, $2, $3, $4, $5, $6, $7)
             RETURNING *;`,
            [service, therapyName, duration, cleanPrice, name, phone, bookingStart.toISOString()]
        );

        await sendTelegramNotification(result.rows[0]);

        res.status(201).json(result.rows[0]);

    } catch (err) {
        console.error('❌ Booking insert failed:', err);
        res.status(500).json({ error: 'Failed to insert booking.' });
    }
});


app.delete('/booking_spa12/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM booking_spa12 WHERE id = $1 RETURNING *;', [id]); // RETURNING * to get deleted row
        if (result.rowCount === 0) {
            return res.status(404).json({ error: `Booking with ID ${id} not found.` });
        }
        // Send Telegram cancellation alert
        await sendTelegramCancellationAlert(result.rows[0]);
        res.status(200).json({ message: `Booking with ID ${id} deleted successfully.` });
    } catch (err) {
        console.error('Error deleting booking from booking_spa12 table:', err);
        res.status(500).json({ error: 'Failed to delete booking from the database.' });
    }
});

// --- API Route for Telegram Bot Cancellation ---
app.post('/telegram-cancel-booking', async (req, res) => {
    // This endpoint should be secured, perhaps with a shared secret or IP whitelist
    // to ensure only your Telegram bot (or legitimate source) can call it.
    const { bookingId } = req.body;

    if (!bookingId) {
        return res.status(400).json({ error: 'Booking ID is required for cancellation.' });
    }

    try {
        // Option 1: Delete the booking
        const result = await pool.query('DELETE FROM booking_spa12 WHERE id = $1 RETURNING *;', [bookingId]);

        if (result.rowCount === 0) {
            console.warn(`Attempted to cancel non-existent booking ID via Telegram: ${bookingId}`);
            return res.status(404).json({ message: `Booking with ID ${bookingId} not found.` });
        }
        // Send Telegram cancellation alert
        await sendTelegramCancellationAlert(result.rows[0]);

        console.log(`Booking with ID ${bookingId} cancelled successfully via Telegram.`);
        res.status(200).json({ message: `Booking with ID ${bookingId} cancelled successfully.` });

        // Option 2 (Recommended): Update booking status to 'cancelled'
        /*
        // You would need a 'status' column in your booking_spa12 table:
        // ALTER TABLE booking_spa12 ADD COLUMN payment_status VARCHAR(50) DEFAULT 'pending';
        const result = await pool.query(
            'UPDATE booking_spa12 SET status = $1 WHERE id = $2 RETURNING *;',
            ['cancelled', bookingId]
        );

        if (result.rowCount === 0) {
            console.warn(`Attempted to cancel non-existent booking ID via Telegram: ${bookingId}`);
            return res.status(404).json({ message: `Booking with ID ${bookingId} not found.` });
        }

        console.log(`Booking with ID ${bookingId} status updated to 'cancelled' via Telegram.`);
        res.status(200).json({ message: `Booking with ID ${bookingId} marked as cancelled successfully.` });
        */

    } catch (err) {
        console.error('Error cancelling booking via Telegram:', err);
        res.status(500).json({ error: 'Failed to cancel booking in the database.' });
    }
});


// --- Payment Initiation ---
app.post('/api/payments/initiate', (req, res) => {
    const { amount, serviceName, bookingId } = req.body;
    if (!amount || !serviceName || !bookingId) {
        return res.status(400).json({ error: 'Payment amount, service name, and booking ID are required to initiate payment.' });
    }
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const simulatedQrCodeUrl = `https://i.postimg.cc/Dz3sgw1N/QR1.jpg?amount=${amount.replace('$', '')}&bookingId=${bookingId}`;
    setTimeout(() => {
        res.status(200).json({
            message: 'Payment initiation successful (simulated). Scan QR to complete.',
            qrCodeUrl: simulatedQrCodeUrl,
            transactionId: transactionId,
            status: 'pending'
        });
    }, 1000);
});

// --- Payment Confirmation ---
app.post('/api/payments/confirm', async (req, res) => {
    const { bookingId } = req.body;
    if (!bookingId) {
        return res.status(400).json({ error: 'Booking ID is required to confirm payment.' });
    }
    try {
        const result = await pool.query(
            'UPDATE booking_spa12 SET payment_status = $1 WHERE id = $2 RETURNING *;',
            ['completed', bookingId]
        );
        if (result.rowCount === 0) {
            console.warn(`Attempted to confirm payment for non-existent booking ID: ${bookingId}`);
            return res.status(404).json({ error: `Booking with ID ${bookingId} not found for payment confirmation.` });
        }
        console.log(`Payment confirmed for Booking ID: ${bookingId}. Status updated to 'completed'.`);
        res.status(200).json({ message: `Payment for booking ID ${bookingId} confirmed successfully.` });
    } catch (err) {
        console.error('Error confirming payment for booking:', err);
        res.status(500).json({ error: 'Failed to update payment status in the database.' });
    }
});

// --- Testimonials ---
app.post('/api/testimonials', async (req, res) => {
    const { reviewerName, reviewerEmail, reviewTitle, reviewText, rating, genuineOpinion } = req.body;
    if (!reviewerName || !reviewerEmail || !reviewText || !rating || genuineOpinion === undefined) {
        return res.status(400).json({ error: 'All testimonial fields (except title) are required.' });
    }
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO testimonials(reviewer_name, reviewer_email, review_title, review_text, rating, genuine_opinion, created_at) VALUES($1, $2, $3, $4, $5, $6, NOW()) RETURNING *;',
            [reviewerName, reviewerEmail, reviewTitle, reviewText, rating, genuineOpinion]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error adding testimonial to database:', err);
        res.status(500).json({ error: 'Failed to add testimonial to the database.' });
    }
});

app.get('/api/testimonials', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM testimonials ORDER BY created_at DESC;');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching testimonials from database:', err);
        res.status(500).json({ error: 'Failed to retrieve testimonials from the database.' });
    }
});

app.delete('/api/testimonials/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM testimonials WHERE id = $1 RETURNING id;', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: `Testimonial with ID ${id} not found.` });
        }
        res.status(200).json({ message: `Testimonial with ID ${id} deleted successfully.` });
    } catch (err) {
        console.error('Error deleting testimonial from database:', err.message || err);
        res.status(500).json({ error: `Failed to delete testimonial from the database: ${err.message || 'Unknown database error'}` });
    }
});

// --- Start the server ---
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    console.log('Ensure your frontend BASE_API_URL is set to this backend URL for full functionality.');
    console.log('New payment initiation endpoint available at http://localhost:3000/api/payments/initiate');
    console.log('New payment confirmation endpoint available at http://localhost:3000/api/payments/confirm');
    console.log('New testimonial submission endpoint available at http://localhost:3000/api/testimonials (POST)');
    console.log('New testimonial retrieval endpoint available at http://localhost:3000/api/testimonials (GET)');
    console.log('New testimonial deletion endpoint available at http://localhost:3000/api/testimonials/:id (DELETE)');
    console.log('New Telegram bot cancellation endpoint available at http://localhost:3000/telegram-cancel-booking (POST)');
});
