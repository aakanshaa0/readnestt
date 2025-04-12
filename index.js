// My personal reading tracker - started as a weekend project
// Built this to keep track of all the books I read and share reviews with friends
// Got tired of using spreadsheets and wanted something more organized
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { MongoClient, ObjectId } = require('mongodb');
const app = express();
const axios = require('axios');

// Basic setup - keeping it minimal for now
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Session config - TODO: move secret to env before deploying
app.use(session({
    secret: process.env.SESSION_SECRET, // Need to change this in prod
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Will change to true when we add HTTPS
}));

// Quick auth check - might need to make this more robust later
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
}

// DB connection - using Atlas for now, might switch to self-hosted later
const dbUrl = process.env.MONGO_URL;
if (!dbUrl) {
    console.error('Fatal: MONGO_URL environment variable is not set');
    process.exit(1);
}

const dbClient = new MongoClient(dbUrl);

// DB connection with retries - learned this the hard way after that outage last month
async function connectToDatabase() {
    let attemptsLeft = 3;
    while (attemptsLeft > 0) {
        try {
            await dbClient.connect();
            console.log('DB connection successful!');
            return;
        } catch (error) {
            console.error('DB connection failed, retrying...', error);
            attemptsLeft--;
            if (attemptsLeft === 0) {
                console.error('Fatal: Could not connect to DB after multiple attempts');
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Initialize DB - crash if we can't connect
connectToDatabase().catch(error => {
    console.error('Fatal: Could not connect to DB', error);
    process.exit(1);
});

// Auth routes
app.get('/signup', (req, res) => {
    res.render('signup', { error: null });
});

// Signup handler - added some basic checks
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    
    // Quick validation - might add more rules later
    if (!username || !password || username.length < 3) {
        return res.render('signup', { error: 'Username must be at least 3 characters' });
    }

    try {
        const hashedPass = await bcrypt.hash(password, 10);
        const myDb = dbClient.db('booknotes');
        
        // Check if username exists - had issues with duplicates before
        const existingAccount = await myDb.collection('users').findOne({ username });
        if (existingAccount) {
            return res.render('signup', { error: 'Username already taken' });
        }

        await myDb.collection('users').insertOne({
            username,
            password: hashedPass,
            createdAt: new Date(),
            lastLogin: null // Will update on first login
        });
        res.redirect('/login');
    } catch (error) {
        console.error('Signup error:', error);
        res.render('signup', { error: 'Something went wrong. Try again?' });
    }
});

// Login page
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// Login handler - added some basic rate limiting
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const myDb = dbClient.db('booknotes');
        const account = await myDb.collection('users').findOne({ username });
        
        if (!account) {
            return res.status(400).send('User not found');
        }
        
        const isPasswordValid = await bcrypt.compare(password, account.password);
        if (!isPasswordValid) {
            return res.status(400).send('Invalid Password');
        }
        
        // Update last login
        await myDb.collection('users').updateOne(
            { _id: account._id },
            { $set: { lastLogin: new Date() } }
        );
        
        req.session.userId = account._id.toString();
        req.session.user = account;
        res.redirect('/');
    } catch (error) {
        console.error('Login error:', error);
        res.render('login', { error: 'Login failed. Try again?' });
    }
});

// Logout - simple but works
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Homepage
app.get('/', requireAuth, async (req, res) => {
    const searchQuery = req.query.search || '';
    const sortBy = req.query.sort;

    try {
        const myDb = dbClient.db('booknotes');
        
        // Build the query
        const query = searchQuery ? {
            $or: [
                { title: { $regex: searchQuery, $options: 'i' } },
                { author: { $regex: searchQuery, $options: 'i' } }
            ]
        } : {};

        // Get books with average ratings and review counts
        const books = await myDb.collection('books')
            .aggregate([
                { $match: query },
                {
                    $group: {
                        _id: {
                            isbn: "$isbn",
                            title: "$title",
                            author: "$author"
                        },
                        avg_rating: { $avg: "$rating" },
                        review_count: { $sum: 1 },
                        last_reviewed: { $max: "$date_read" }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        isbn: "$_id.isbn",
                        title: "$_id.title",
                        author: "$_id.author",
                        avg_rating: { $round: ["$avg_rating", 1] },
                        review_count: 1,
                        last_reviewed: 1
                    }
                },
                { $sort: sortBy === 'rating' ? { avg_rating: -1 } : { last_reviewed: -1 } }
            ])
            .toArray();

        res.render('index', {
            books,
            user: req.session.user,
            searchQuery
        });
    } catch (err) {
        console.error('Error fetching books:', err);
        res.status(500).send('Error fetching books');
    }
});

// Add book form
app.get('/add', requireAuth, async (req, res) => {
    const currentUser = req.session.user;
    res.render('add_book', { user: currentUser, book: {}, searchQuery: '' });
});

// Add book handler - with some data cleaning
app.post('/add', requireAuth, async (req, res) => {
    const { title, author, rating, notes, date_read, isbn, category } = req.body;
    const currentUserId = req.session.userId;

    // Basic validation - might add more later
    if (!title || !author) {
        return res.status(400).send('Title and author are required');
    }

    try {
        const myDb = dbClient.db('booknotes');
        await myDb.collection('books').insertOne({
            title: title.trim(),
            author: author.trim(),
            rating: Number(rating) || 0,
            notes: notes.trim(),
            date_read: new Date(date_read),
            isbn: isbn.trim(),
            user_id: currentUserId,
            category: category || 'Uncategorized',
            createdAt: new Date(),
            updatedAt: new Date()
        });
        res.redirect('/');
    } catch (error) {
        console.error('Error adding book:', error);
        res.status(500).send('Error adding book');
    }
});

// Edit book form
app.get('/edit/:id', requireAuth, async (req, res) => {
    const bookId = req.params.id;

    try {
        const myDb = dbClient.db('booknotes');
        const bookToEdit = await myDb.collection('books').findOne({ _id: new ObjectId(bookId) });
        
        if (!bookToEdit) {
            return res.status(404).send('Book not found');
        }
        
        if (bookToEdit.user_id !== req.session.userId) {
            return res.status(403).send('Not your book to edit');
        }

        // Format the date for the form
        let formattedDate = '';
        if (bookToEdit.date_read) {
            const date = new Date(bookToEdit.date_read);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            formattedDate = `${year}-${month}-${day}`;
        }

        res.render('edit_book', { 
            book: {
                ...bookToEdit,
                id: bookToEdit._id.toString(),
                date_read: formattedDate
            }, 
            user: req.session.user, 
            searchQuery: '' 
        });
    } catch (error) {
        console.error('Error fetching book:', error);
        res.status(500).send('Error fetching book');
    }
});

// Update book handler
app.post('/edit/:id', requireAuth, async (req, res) => {
    const bookId = req.params.id;
    const { title, author, rating, notes, date_read, isbn, category } = req.body;

    try {
        const myDb = dbClient.db('booknotes');
        const bookToUpdate = await myDb.collection('books').findOne({ _id: new ObjectId(bookId) });

        if (!bookToUpdate) {
            return res.status(404).send('Book not found');
        }
        
        if (bookToUpdate.user_id !== req.session.userId) {
            return res.status(403).send('Not your book to edit');
        }

        await myDb.collection('books').updateOne(
            { _id: new ObjectId(bookId) },
            {
                $set: {
                    title: title.trim(),
                    author: author.trim(),
                    rating: Number(rating) || 0,
                    notes: notes.trim(),
                    date_read: new Date(date_read),
                    isbn: isbn.trim(),
                    category: category || 'Uncategorized',
                    updatedAt: new Date()
                }
            }
        );

        res.redirect('/');
    } catch (error) {
        console.error('Error updating book:', error);
        res.status(500).send('Error updating book');
    }
});

// Delete book handler
app.post('/delete/:id', requireAuth, async (req, res) => {
    const bookId = req.params.id;
    const currentUserId = req.session.userId;

    try {
        const myDb = dbClient.db('booknotes');
        const bookToDelete = await myDb.collection('books').findOne({ _id: new ObjectId(bookId) });

        if (!bookToDelete) {
            return res.status(404).send('Book not found');
        }

        if (bookToDelete.user_id !== currentUserId) {
            return res.status(403).send('Not your book to delete');
        }

        await myDb.collection('books').deleteOne({ _id: new ObjectId(bookId) });
        res.redirect('/profile');
    } catch (error) {
        console.error('Error deleting book:', error);
        res.status(500).send('Error deleting book');
    }
});

// Top reviews page - shows 5-star books
app.get('/top_reviews', requireAuth, async (req, res) => {
    const sortOption = req.query.sort;
    const searchTerm = req.query.search;

    try {
        const myDb = dbClient.db('booknotes');
        
        // Build the query for 5-star books
        const query = { rating: 5 };
        
        // Add search filter if search term is provided
        if (searchTerm) {
            query.$or = [
                { title: { $regex: searchTerm, $options: 'i' } },
                { author: { $regex: searchTerm, $options: 'i' } }
            ];
        }

        // Get all 5-star books with user information
        const books = await myDb.collection('books')
            .find(query)
            .sort(sortOption === 'rating' ? { rating: -1 } : { date_read: -1 })
            .toArray();

        // Get user information and calculate average ratings for each book
        const booksWithUsers = await Promise.all(books.map(async (book) => {
            const user = await myDb.collection('users').findOne({ _id: new ObjectId(book.user_id) });
            
            // Calculate average rating for this book
            const bookReviews = await myDb.collection('books')
                .find({ isbn: book.isbn })
                .toArray();
            
            const avgRating = bookReviews.reduce((sum, review) => sum + review.rating, 0) / bookReviews.length;

            return {
                ...book,
                id: book._id.toString(),
                username: user ? user.username : 'Unknown',
                profile_picture: user ? (user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`) : null,
                date_read: book.date_read ? new Date(book.date_read).toLocaleDateString() : 'Not specified',
                avg_rating: avgRating,
                review_count: bookReviews.length
            };
        }));

        // Sort books by average rating if requested
        if (sortOption === 'rating') {
            booksWithUsers.sort((a, b) => b.avg_rating - a.avg_rating);
        }

        res.render('top_reviews', {
            books: booksWithUsers,
            user: req.session.user,
            searchQuery: searchTerm || '',
            currentSort: sortOption || 'date_read'
        });
    } catch (error) {
        console.error('Error fetching top reviews:', error);
        res.status(500).send('Error fetching top reviews. Please try again later.');
    }
});

// Contact Me
app.get('/contact', requireAuth, async(req, res)=>{
    const user = req.session.user;
    res.render('contact', {user, message: null, error: null, searchQuery: ''});
});

app.post('/contact', async(req, res)=>{
    const { fullname, email, message } = req.body;
    try {
        const myDb = dbClient.db('booknotes');
        await myDb.collection('messages').insertOne({
            fullname,
            email,
            message,
            createdAt: new Date()
        });
        res.render('contact', {
            message: 'Thank you for your message! I will get back to you soon.',
            error: null,
            user: req.session.user,
            searchQuery: ''
        });
    } catch(err) {
        console.error('Error saving message:', err);
        res.render('contact', {
            message: null,
            error: 'Failed to send your message. Please try again.',
            user: req.session.user,
            searchQuery: ''
        });
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
        const myDb = dbClient.db('booknotes');
        const user = await myDb.collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        
        if (!user) {
            return res.status(404).send('User not found');
        }

        const books = await myDb.collection('books')
            .find({ user_id: req.session.userId })
            .sort({ date_read: -1 })
            .toArray();

        res.render('profile', {
            user: {
                id: user._id.toString(),
                username: user.username,
                profile_picture: user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`,
                bio: user.bio || ''
            },
            books: books,
            isCurrentUser: true,
            searchQuery: req.query.search || ''
        });
    } catch(err) {
        console.error('Profile error:', err);
        res.status(500).send('Error loading profile');
    }
});

// Edit Profile Route
app.get('/profile/edit', requireAuth, async (req, res) => {
    try {
        const myDb = dbClient.db('booknotes');
        const user = await myDb.collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        
        if (!user) {
            return res.status(404).send('User not found');
        }

        res.render('edit_profile', {
            user: {
                id: user._id.toString(),
                username: user.username,
                profile_picture: user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`,
                bio: user.bio || ''
            },
            searchQuery: ''
        });
    } catch(err) {
        console.error('Edit profile error:', err);
        res.status(500).send('Error loading edit profile page');
    }
});

app.get('/profile/:id', requireAuth, async(req, res)=>{
    const {id} = req.params;
    const loggedInUserId = req.session.userId;

    try {
        const myDb = dbClient.db('booknotes');
        const user = await myDb.collection('users').findOne({ _id: new ObjectId(id) });
        
        if (!user) {
            return res.status(404).send('User not found');
        }

        const books = await myDb.collection('books')
            .find({ user_id: id })
            .sort({ date_read: -1 })
            .toArray();

        res.render('profile', {
            user: {
                id: user._id.toString(),
                username: user.username,
                profile_picture: user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`,
                bio: user.bio || ''
            },
            books: books,
            isCurrentUser: loggedInUserId === id,
            searchQuery: req.query.search || ''
        });
    } catch(err) {
        console.error('Profile view error:', err);
        res.status(500).send('Error loading profile');
    }
});

// Update Profile Route
app.post('/profile/edit', requireAuth, async(req, res)=>{
    try {
        const {username, bio} = req.body;
        const myDb = dbClient.db('booknotes');
        
        await myDb.collection('users').updateOne(
            { _id: new ObjectId(req.session.userId) },
            { 
                $set: {
                    username: username,
                    bio: bio,
                    updatedAt: new Date()
                }
            }
        );

        const updatedUser = await myDb.collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        
        req.session.user = {
            id: updatedUser._id.toString(),
            username: updatedUser.username,
            profile_picture: updatedUser.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(updatedUser.username)}`,
            bio: updatedUser.bio || ''
        };
        
        res.redirect('/profile');
    } catch(err) {
        console.error('Profile update error:', err);
        res.status(500).send('Error updating profile');
    }
});

// Book Reviews - shows all reviews for a book
app.get('/books/:isbn', requireAuth, async (req, res) => {
    const { isbn } = req.params;
    const sortBy = req.query.sort;

    try {
        const myDb = dbClient.db('booknotes');
        
        // First, get the book details
        const bookDetails = await myDb.collection('books').findOne({ isbn: isbn });
        
        if (!bookDetails) {
            return res.status(404).send('Book not found');
        }

        // Get all reviews for this book with user information
        const reviews = await myDb.collection('books')
            .find({ isbn: isbn })
            .sort(sortBy === 'rating' ? { rating: -1 } : { date_read: -1 })
            .toArray();

        // Get user information for each review
        const reviewsWithUsers = await Promise.all(reviews.map(async (review) => {
            const user = await myDb.collection('users').findOne({ _id: new ObjectId(review.user_id) });
            return {
                ...review,
                id: review._id.toString(),
                username: user ? user.username : 'Unknown',
                profile_picture: user ? (user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`) : null,
                date_read: review.date_read ? new Date(review.date_read).toLocaleDateString() : 'Not specified'
            };
        }));

        // Calculate average rating
        const avgRating = reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length;

        res.render('book_reviews', {
            book: {
                title: bookDetails.title,
                author: bookDetails.author,
                isbn: bookDetails.isbn,
                avg_rating: avgRating.toFixed(1),
                review_count: reviews.length
            },
            reviews: reviewsWithUsers,
            user: req.session.user,
            currentSort: sortBy || 'date_read'
        });
    } catch (err) {
        console.error('Error fetching book reviews:', err);
        console.error('ISBN being searched:', isbn);
        res.status(500).send('Error fetching book reviews. Please try again later.');
    }
});

// Individual Review Details
app.get('/reviews/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const myDb = dbClient.db('booknotes');
        
        // Get the review with user information
        const review = await myDb.collection('books')
            .findOne({ _id: new ObjectId(id) });

        if (!review) {
            return res.status(404).send('Review not found.');
        }

        // Get user information
        const user = await myDb.collection('users')
            .findOne({ _id: new ObjectId(review.user_id) });

        // Format the review data
        const formattedReview = {
            ...review,
            id: review._id.toString(),
            username: user ? user.username : 'Unknown',
            profile_picture: user ? (user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`) : null,
            bio: user ? user.bio : '',
            date_read: review.date_read ? new Date(review.date_read).toLocaleDateString() : 'Not specified'
        };

        res.render('review_detail', {
            review: formattedReview,
            user: req.session.user,
            searchQuery: ''
        });
    } catch (err) {
        console.error('Error fetching review details:', err);
        res.status(500).send('Error fetching review details. Please try again later.');
    }
});

// Category page
app.get('/category/:categoryName', requireAuth, async (req, res) => {
    const { categoryName } = req.params;
    const sortOption = req.query.sort;
    const searchTerm = req.query.search;

    try {
        const myDb = dbClient.db('booknotes');
        
        // Build the query for the category
        const query = { category: categoryName };
        
        // Add search filter if search term is provided
        if (searchTerm) {
            query.$or = [
                { title: { $regex: searchTerm, $options: 'i' } },
                { author: { $regex: searchTerm, $options: 'i' } }
            ];
        }

        // Get all books in this category with user information
        const books = await myDb.collection('books')
            .find(query)
            .sort(sortOption === 'rating' ? { rating: -1 } : { date_read: -1 })
            .toArray();

        // Get user information for each book
        const booksWithUsers = await Promise.all(books.map(async (book) => {
            const user = await myDb.collection('users').findOne({ _id: new ObjectId(book.user_id) });
            
            // Calculate average rating for this book
            const bookReviews = await myDb.collection('books')
                .find({ isbn: book.isbn })
                .toArray();
            
            const avgRating = bookReviews.reduce((sum, review) => sum + review.rating, 0) / bookReviews.length;

            return {
                ...book,
                id: book._id.toString(),
                username: user ? user.username : 'Unknown',
                profile_picture: user ? (user.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}`) : null,
                date_read: book.date_read ? new Date(book.date_read).toLocaleDateString() : 'Not specified',
                avg_rating: avgRating,
                review_count: bookReviews.length
            };
        }));

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
            'Biography': 'Stories about real peoples lives.',
            'Self-Help': 'Books offering advice and strategies for personal growth.',
            'Poetry': 'Collections of poems expressing emotions and ideas.',
            'Childrens Books': 'Books written for young readers.',
            'Graphic Novels': 'Illustrated stories, including comics and manga.'
        };

        const description = categoryDescriptions[categoryName] || 'No description available.';

        res.render('category', {
            books: booksWithUsers,
            category: categoryName,
            description,
            user: req.session.user,
            searchQuery: searchTerm || '',
            currentSort: sortOption || 'date_read'
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