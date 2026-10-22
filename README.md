# 🍽️ LUX Restaurant Backend

> The backend API for **LUX**, a full-stack restaurant management platform that enables customers to explore menus, reserve tables, and place food orders through a modern web application.

## 📖 Overview

LUX Restaurant Backend powers the server-side functionality of the LUX restaurant management platform. Built with **Node.js, Express.js, and MongoDB**, it provides RESTful APIs for authentication, menu management, user management, orders, and table reservations.

**Live Application:** https://luxrestaurant.vercel.app/

**Backend API:** https://lux-restaurant-backend.onrender.com

The project is built using the **MERN Stack** with a focus on scalability, clean architecture, and maintainable code.

---

## ✨ Features

- 🔐 Secure User Authentication (JWT)
- 👥 Role-Based Authorization
- 🍽️ Restaurant Menu Management
- 📦 Order Management
- 🪑 Table Reservation System
- 🖼️ Food Image Upload
- 🌐 RESTful API Architecture
- 🗄️ MongoDB Database Integration
- ⚡ Express Middleware Implementation

---

## 🛠️ Tech Stack

| Technology | Usage |
|------------|-------|
| Node.js | Runtime Environment |
| Express.js | Backend Framework |
| MongoDB | Database |
| Mongoose | ODM |
| JWT | Authentication |
| Bcrypt | Password Hashing |
| Multer | Image Upload |
| CORS | Cross-Origin Requests |
| Dotenv | Environment Variables |

---

## 📂 Project Structure

```text
LUX-Restaurant-Backend/
│
├── config/
├── controllers/
├── middleware/
├── models/
├── routes/
├── uploads/
├── utils/
├── server.js
├── package.json
└── README.md
```

---

## ⚙️ Installation & Setup

### Prerequisites

- [Node.js](https://nodejs.org/) and npm
- A MongoDB database (local or cloud-hosted)
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/Sourav142005/LUX-Restaurant-Backend.git
cd LUX-Restaurant-Backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
```

Replace the example values with your own. Check the source code for any additional required environment variables, such as AI or payment API credentials. Never commit real secrets to GitHub.

### 4. Start the Development Server

```bash
npm run dev
```

### 5. Start in Production Mode

```bash
npm start
```

### 6. Run Tests

```bash
npm test
```

This runs the project's Node.js test files under `tests/`.

## 📡 Available Modules

- Authentication
- User Management
- Restaurant Menu
- Categories
- Orders
- Table Reservations

---

## 📌 Project Status

🚧 **Currently Under Development**

The backend is actively being developed as part of the **LUX-S Full-Stack Restaurant Management Platform**.

Completed and upcoming modules are being added incrementally as development progresses.

---

## 🤝 Contributing

Contributions, suggestions, and feedback are always welcome.

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Open a Pull Request

---

## 👨‍💻 Author

**Sourav Shridhar Kamble**

📧 Email: sourav142005@gmail.com

💼 LinkedIn: https://www.linkedin.com/in/sourav-kamble

💻 GitHub: https://github.com/Sourav142005

---

## 📄 License

This project is developed for educational and learning purposes.
