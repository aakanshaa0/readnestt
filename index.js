require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const app = express();
const axios = require('axios');

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
}

// Database connection using environment variables
const pool = new Pool({
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    database: process.env.PG_DATABASE
});

// Routes
// Signup Route
app.get('/signup',(req, res)=>{
    res.render('signup',{error:null});
});

app.post('/signup',async(req, res)=>{
    const {username, password}=req.body;
    try{
        const hashedPassword=await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (username, password) VALUES ($1, $2)',
            [username, hashedPassword]
        );
        res.redirect('/login');
    }catch(err){
        console.log(err);
        res.render('signup', {error: 'Error creating user'});
    }
});

// Login Route
app.get('/login',(req, res)=>{
    res.render('login', {error: null});
});

app.post('/login', async(req, res)=>{
    const {username, password}=req.body;
    try{
        const result=await pool.query('SELECT * FROM users WHERE username=$1', [username]);
        const user=result.rows[0];
        if (!user) {
            return res.status(400).send('User not found');
        }
        const validPassword=await bcrypt.compare(password, user.password);
        if(!validPassword){
            return res.status(400).send('Invalid Password');
        }
        req.session.userId=user.id;
        req.session.user=user;
        res.redirect('/');
    }catch(err){
        console.log(err);
        res.render('login', {error: 'Login failed'});
    }
});

// Logout Route
app.get('/logout', (req, res)=>{
    req.session.destroy(()=>{
        res.redirect('/login');
    });
});

// Root Route (Homepage)
app.get('/', requireAuth, async(req, res)=>{
    const sortBy = req.query.sort;
    const searchQuery = req.query.search;

    let orderByClause = 'ORDER BY MAX(date_read) DESC';
    if (sortBy === 'rating') orderByClause = 'ORDER BY avg_rating DESC';
    else if (sortBy === 'date_read') orderByClause = 'ORDER BY MAX(date_read) DESC';

    let whereClause = '';
    if (searchQuery) {
        whereClause = `WHERE title ILIKE '%${searchQuery}%' OR author ILIKE '%${searchQuery}%'`;
    }

    try {
        const booksResult = await pool.query(`
            SELECT 
                title, 
                author, 
                isbn, 
                MAX(date_read) as last_reviewed, 
                COALESCE(AVG(rating)::FLOAT, 0) as avg_rating
            FROM books
            ${whereClause}
            GROUP BY title, author, isbn
            ${orderByClause}
        `);
        const books = booksResult.rows;

        const user = req.session.user;
        res.render('index', { books, user, searchQuery: searchQuery || '' });
    } catch (err) {
        console.log(err);
        res.status(500).send('Error fetching books');
    }
});

// Add book Form
app.get('/add', requireAuth, async(req, res)=>{
    const user=req.session.user;
    res.render('add_book', { user, book: {}, searchQuery: '' });
});

app.post('/add', requireAuth, async (req, res) => {
    const { title, author, rating, notes, date_read, isbn, category } = req.body;
    const userId = req.session.userId;

    try {
        await pool.query(
            'INSERT INTO books (title, author, rating, notes, date_read, isbn, user_id, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [title, author, rating, notes, date_read, isbn, userId, category]
        );
        res.redirect('/');
    } catch (err) {
        console.log(err);
        res.status(500).send('Error adding book');
    }
});

// Edit book Form
// Route to fetch book data for editing
app.get('/edit/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const bookResult = await pool.query('SELECT * FROM books WHERE id = $1', [id]);
        const book = bookResult.rows[0];
        if (!book) {
            return res.status(404).send('Book not found');
        }
        if (book.user_id !== req.session.userId) {
            return res.status(403).send('You are not authorized to edit this book.');
        }

        res.render('edit_book', { book, user: req.session.user, searchQuery: '' });
    } catch (err) {
        console.error('Error fetching book for editing:', err);
        res.status(500).send('Error fetching book for editing');
    }
});

app.post('/edit/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { title, author, rating, notes, date_read, isbn, category } = req.body;

    try {
        const bookResult = await pool.query('SELECT * FROM books WHERE id = $1', [id]);
        const book = bookResult.rows[0];

        if (!book) {
            return res.status(404).send('Book not found');
        }
        if (book.user_id !== req.session.userId) {
            return res.status(403).send('You are not authorized to edit this book.');
        }
        await pool.query(
            'UPDATE books SET title = $1, author = $2, rating = $3, notes = $4, date_read = $5, isbn = $6, category = $7 WHERE id = $8',
            [title, author, rating, notes, date_read, isbn, category, id]
        );

        res.redirect('/');
    } catch (err) {
        console.error('Error updating book:', err);
        res.status(500).send('Error updating book');
    }
});

// Delete Book Route
app.post('/delete/:id', requireAuth, async (req, res) => {
    const {id} = req.params;
    const userId = req.session.userId;

    try{
        const bookResult = await pool.query('SELECT * FROM books WHERE id = $1', [id]);
        const book = bookResult.rows[0];

        if(!book){
            return res.status(404).send('Book not found');
        }

        if(book.user_id !== userId){
            return res.status(403).send('You are not authorized to delete this book.');
        }

        await pool.query('DELETE FROM books WHERE id = $1', [id]);
        res.redirect('/profile');
    }catch(err){
        console.error(err);
        res.status(500).send('Error deleting book');
    }
});

// Top Reviews
app.get('/top_reviews', requireAuth, async (req, res) => {
    const sortBy = req.query.sort;
    const searchQuery = req.query.search;

    let orderByClause = 'ORDER BY books.date_read DESC';
    if (sortBy === 'rating') orderByClause = 'ORDER BY books.rating DESC';
    else if (sortBy === 'date_read') orderByClause = 'ORDER BY books.date_read DESC';

    let whereClause = "WHERE books.rating = 5";
    if (searchQuery) {
        whereClause += ` AND (books.title ILIKE '%${searchQuery}%' OR books.author ILIKE '%${searchQuery}%')`;
    }

    try {
        const booksResult = await pool.query(`
            SELECT 
                books.id,
                books.title,
                books.author,
                books.isbn,
                books.date_read,
                books.rating as avg_rating,
                users.username
            FROM books
            JOIN users ON books.user_id = users.id
            ${whereClause}
            GROUP BY books.id, users.username
            ${orderByClause}
        `);
        
        const books = booksResult.rows;
        const user = req.session.user;
        res.render('top_reviews', { books, user, searchQuery: searchQuery || '' });
    } catch (err) {
        console.log(err);
        res.status(500).send('Error fetching top reviews');
    }
});

// Contact Me
app.get('/contact', requireAuth, async(req, res)=>{
    const user=req.session.user;
    res.render('contact', {user, message: null, error: null, searchQuery: ''});
});

app.post('/contact', async(req, res)=>{
    const { fullname, email, message}=req.body;
    try {
        await pool.query(
            'INSERT INTO messages (fullname, email, message) VALUES ($1, $2, $3)',
            [fullname, email, message]
        );
        res.render('contact', {message: 'Thank you for your message! I will get back to you soon.', error: null, user: req.session.user, searchQuery: ''});
    }catch(err){
        console.error('Error saving message:', err);
        res.render('contact', {message: null, error: 'Failed to send your message. Please try again.', user: req.session.user, searchQuery: ''});
    }
});

// About Me
app.get('/about', requireAuth, async(req, res)=>{
    const user = req.session.user;
    res.render('about', {user, searchQuery: ''});
});

// Profile Route
app.get('/profile', requireAuth, async(req, res)=>{
    try {
        const userResult = await pool.query(
            `SELECT 
                id, 
                username, 
                COALESCE(profile_picture, 'https://ui-avatars.com/api/?name=' || REPLACE(username, ' ', '+')) AS profile_picture, 
                COALESCE(bio, '') AS bio 
             FROM users 
             WHERE id = $1`,
            [req.session.userId]
        );
        const user = userResult.rows[0];
        const booksResult = await pool.query(
            `SELECT * FROM books 
             WHERE user_id = $1 
             ORDER BY date_read DESC`,
            [req.session.userId]
        );
        res.render('profile',{
            user: user,
            books: booksResult.rows,
            isCurrentUser: true,
            searchQuery: req.query.search || ''
        });
    }catch(err){
        console.error(err);
        res.status(500).send('Error loading profile');
    }
});

// Edit Profile Route
app.get('/profile/edit', requireAuth, async (req, res) => {
    try {
        const result=await pool.query(
            `SELECT 
                id, 
                username, 
                COALESCE(profile_picture, 'https://ui-avatars.com/api/?name=' || REPLACE(username, ' ', '+')) AS profile_picture, 
                COALESCE(bio, '') AS bio 
             FROM users 
             WHERE id = $1`,
            [req.session.userId]
        );

        const user=result.rows[0];
        res.render('edit_profile', {user, searchQuery: ''});
    }catch(err){
        console.error('Error in /profile/edit route:', err);
        res.status(500).send('Error loading edit profile page');
    }
});

app.get('/profile/:id', requireAuth, async(req, res)=>{
    const {id}=req.params;
    const loggedInUserId=req.session.userId;

    try{
        const userResult=await pool.query(
            `SELECT 
                id, 
                username, 
                COALESCE(profile_picture, 'https://ui-avatars.com/api/?name=' || REPLACE(username, ' ', '+')) AS profile_picture, 
                COALESCE(bio, '') AS bio 
             FROM users 
             WHERE id = $1`,
            [id]
        );

        const user=userResult.rows[0];
        const booksResult=await pool.query(
            `SELECT * FROM books 
             WHERE user_id = $1 
             ORDER BY date_read DESC`,
            [id]
        );
        const isCurrentUser=loggedInUserId===user.id;
        res.render('profile', {
            user: user,
            books: booksResult.rows,
            isCurrentUser: isCurrentUser,
            searchQuery: req.query.search || ''
        });

    }catch(err){
        console.error(err);
        res.status(500).send('Error loading profile');
    }
});

// Update Profile Route
app.post('/profile/edit', requireAuth, async(req, res)=>{
    try{
        const {username,bio}=req.body;
        await pool.query(
            `UPDATE users 
             SET 
                username = $1,
                bio = $2
             WHERE id = $3`,
            [username, bio, req.session.userId]
        );

        const updatedUser=await pool.query(
            `SELECT 
                id, 
                username, 
                COALESCE(profile_picture, 'https://ui-avatars.com/api/?name=' || REPLACE(username, ' ', '+')) AS profile_picture, 
                COALESCE(bio, '') AS bio 
             FROM users 
             WHERE id = $1`,
            [req.session.userId]
        );
        req.session.user=updatedUser.rows[0];
        res.redirect('/profile');

    }catch(err){
        console.error('Profile update error:', err);
        res.status(500).send('Error updating profile');
    }
});

app.get('/books/:isbn', requireAuth, async (req, res) => {
    const { isbn } = req.params;
    const sortBy = req.query.sort;

    try {
        const bookResult = await pool.query('SELECT * FROM books WHERE isbn = $1 LIMIT 1', [isbn]);
        const book = bookResult.rows[0];

        if (!book) {
            return res.status(404).send('Book not found');
        }

        const reviewsResult = await pool.query(`
            SELECT 
                books.*, 
                users.username, 
                users.profile_picture,
                users.bio
            FROM books 
            JOIN users ON books.user_id = users.id
            WHERE books.isbn = $1
            ORDER BY ${sortBy === 'rating' ? 'books.rating DESC' : 'books.date_read DESC'}
        `, [isbn]);

        const reviews = reviewsResult.rows;

        res.render('book_reviews', {
            book,
            reviews,
            user: req.session.user,
            currentSort: sortBy || 'date_read'
        });
    } catch (err) {
        console.error('Error fetching book reviews:', err);
        res.status(500).send('Error fetching book reviews');
    }
});

app.get('/reviews/:id', requireAuth, async(req, res)=>{
    const {id}=req.params;

    try {
        const reviewResult = await pool.query(`
            SELECT 
                books.*, 
                users.username, 
                users.profile_picture,
                users.bio
            FROM books 
            JOIN users ON books.user_id = users.id
            WHERE books.id = $1
        `, [id]);
        const review = reviewResult.rows[0];
        res.render('review_detail', {review, user: req.session.user});
    }catch(err){
        console.error(err);
        res.status(500).send('Error fetching review details');
    }
});

// Existing Categories
app.get('/category/:categoryName', requireAuth, async (req, res) => {
    const { categoryName } = req.params;

    try {
        const booksResult = await pool.query(`
            SELECT books.*, users.username 
            FROM books 
            JOIN users ON books.user_id = users.id
            WHERE books.category = $1
            ORDER BY books.date_read DESC
        `, [categoryName]);

        const books = booksResult.rows;

        // Define category descriptions
        const categoryDescriptions = {
            'Fiction': 'Imaginary stories and narratives.',
            'Non-Fiction': 'Fact-based books about real events, people, or ideas.',
            'Mystery-Thriller': 'Suspenseful stories involving crime, puzzles, or danger.',
            'Science Fiction': 'Futuristic or speculative stories about technology, space, or alternate realities.',
            'Fantasy': 'Stories with magic, mythical creatures, and imaginary worlds.',
            'Romance': 'Books centered around love and relationships.',
            'Horror': 'Stories designed to scare or unsettle readers.',
            'Historical': 'Books set in or about the past, whether fiction or non-fiction.',
            'Young Adult (YA)': 'Books targeted at teenagers, often with coming-of-age themes.',
            'Biography': 'Stories about real people’s lives.',
            'Self-Help': 'Books offering advice and strategies for personal growth.',
            'Poetry': 'Collections of poems expressing emotions and ideas.',
            'Children’s Books': 'Books written for young readers.',
            'Graphic Novels': 'Illustrated stories, including comics and manga.'
        };

        const description = categoryDescriptions[categoryName] || 'No description available.';

        res.render('category', {
            books,
            category: categoryName,
            description,
            user: req.session.user,
            searchQuery: req.query.search || ''
        });
    } catch (err) {
        console.error('Error fetching category books:', err);
        res.status(500).send('Error fetching category books');
    }
});

app.get('/privacy', (req, res) => {
    res.render('still_working_on_it', { user: req.session.user, searchQuery: '' });
});

app.get('/terms', (req, res) => {
    res.render('still_working_on_it', { user: req.session.user, searchQuery: '' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on Port ${PORT}`);
});