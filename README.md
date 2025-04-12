# ReadNest

A simple web app to track and review books you've read.

## Features

- Add, edit, and delete book reviews
- Rate books from 1 to 5 stars
- Add personal notes for each book
- Sort books by category
- View other users' reviews
- Automatic book cover images

## Tech Used

- Node.js and Express.js
- MongoDB
- EJS templates
- CSS

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/BookNotes.git
   cd BookNotes
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create .env file:
   ```
   MONGO_URL=your_mongodb_connection_string
   SESSION_SECRET=your_session_secret
   ```

4. Start the server:
   ```bash
   npm start
   ```

The app will run at http://localhost:3001

## Project Structure

```
BookNotes/
├── public/
│   ├── css/
│   └── img/
├── views/
│   ├── partials/
│   └── pages
├── .env
├── index.js
└── package.json
```

## How to Use

1. Sign up or log in
2. Add books with reviews
3. Rate and categorize books
4. View and manage your reviews
5. Browse books by category
