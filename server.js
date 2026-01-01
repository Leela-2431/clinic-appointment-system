// server.js (complete file) - replace your current server.js with this
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const PDFDocument = require("pdfkit");
const { PassThrough } = require("stream");
const conn = require("./db"); // your db connection file
const flash = require("connect-flash");

const app = express();
const PORT = process.env.PORT || 3006;

// ---------------- Middleware Setup ----------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.urlencoded({ extended: true }));

// Session Setup
app.use(
  session({
    secret: "clinic-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// Flash messages
app.use(flash());

// Make session & flash messages available in all EJS templates
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  next();
});

// Utility Function (format time for views)
const formatTime = (timeStr) => {
  if (!timeStr) return "";
  const [hour, minute] = timeStr.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const formattedHour = ((hour + 11) % 12) + 1;
  return `${formattedHour}:${minute.toString().padStart(2, "0")} ${suffix}`;
};
app.locals.formatTime = formatTime;

// ---------------- Patient Routes ----------------
app.get("/", (req, res) => res.render("home"));

// If some code redirects to /patient-login, provide that route as alias to login-register
app.get("/patient-login", (req, res) => {
  // show same login/register screen
  const showMsg = req.session.showMsg;
  req.session.showMsg = false;
  res.render("login-register", { showMsg });
});

// Login & Register - GET
app.get("/login-register", (req, res) => {
  const showMsg = req.session.showMsg;
  req.session.showMsg = false;
  res.render("login-register", { showMsg });
});

// POST handler for login if your form posts to /login-register
app.post("/login-register", (req, res) => {
  // Treat as login attempt (login form posts to this path in some versions)
  const { email, password } = req.body;
  if (!email || !password) {
    return res.send("Please provide email and password. <a href='/login-register'>Back</a>");
  }
  const query = "SELECT * FROM patients WHERE email = ? AND password = ?";
  conn.query(query, [email, password], (err, results) => {
    if (err) {
      console.error("Login error:", err);
      return res.send("Error during login. Try again.");
    }
    if (results && results.length > 0) {
      req.session.patient = results[0];
      return res.redirect("/dashboard");
    } else {
      return res.send("Invalid credentials. <a href='/login-register'>Try again</a>");
    }
  });
});

// Legacy (or alternative) explicit login route (keeps your existing code)
app.post("/patient-login", (req, res) => {
  const { email, password } = req.body;
  const query = "SELECT * FROM patients WHERE email = ? AND password = ?";
  conn.query(query, [email, password], (err, results) => {
    if (err) {
      console.error("Error in /patient-login:", err);
      return res.send("Error: " + err);
    }
    if (results && results.length > 0) {
      req.session.patient = results[0];
      res.redirect("/dashboard");
    } else {
      res.send("Invalid credentials. <a href='/login-register'>Try again</a>");
    }
  });
});

// Registration (keeps your existing behavior)
app.post("/patient-register", (req, res) => {
  const { name, email, password } = req.body;
  const query = "INSERT INTO patients (name, email, password) VALUES (?, ?, ?)";
  conn.query(query, [name, email, password], (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.send("Email already registered. <a href='/login-register'>Try again</a>");
      }
      console.error("Registration error:", err);
      return res.send("Error: " + err);
    }
    req.session.showMsg = true;
    res.redirect("/login-register");
  });
});

// Dashboard
app.get("/dashboard", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");
  res.render("dashboard", { name: req.session.patient.name, session: req.session });
});

// Profile
app.get("/profile", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");
  res.render("profile", { patient: req.session.patient, session: req.session });
});

// Update Phone (GET + POST)
app.get("/update-phone", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");
  res.render("update-phone", { session: req.session });
});

app.post("/update-phone", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");

  const { phone } = req.body;
  const id = req.session.patient.id;
  const sql = "UPDATE patients SET phone = ? WHERE id = ?";
  conn.query(sql, [phone, id], (err) => {
    if (err) {
      console.error("Error updating phone:", err);
      return res.send("Error updating phone number");
    }

    // Update session object (so profile shows updated phone if needed)
    req.session.patient.phone = phone;

    res.render("success", {
      title: "Phone Updated",
      message: "Phone number updated successfully!",
      redirect: "/dashboard",
    });
  });
});

// My Appointments
app.get("/my-appointments", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");

  const patientId = req.session.patient.id;
  const sql = `
    SELECT a.id, a.appointment_date, a.appointment_time,
           d.name AS doctor_name, d.specialization
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    WHERE a.patient_id = ?
    ORDER BY a.appointment_date DESC, a.appointment_time DESC
  `;
  conn.query(sql, [patientId], (err, appointments) => {
    if (err) {
      console.error("Error fetching appointments for patient:", err);
      return res.send("Error fetching appointments.");
    }
    res.render("my-appointments", { appointments, session: req.session });
  });
});

// Patient Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.send("Error logging out. Try again.");
    }
    res.redirect("/login-register");
  });
});

// ---------------- Book Appointment Routes ----------------
// GET: show booking form (list doctors)
app.get("/book-appointment", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");

  const sql = "SELECT id, name, specialization, available_from, available_to, available_days FROM doctors ORDER BY name";
  conn.query(sql, (err, doctors) => {
    if (err) {
      console.error("Error fetching doctors:", err);
      return res.send("Error loading booking page.");
    }
    return res.render("book-appointment", { doctors, session: req.session });
  });
});

// POST: create appointment (check double-booking)
app.post("/book-appointment", (req, res) => {
  if (!req.session.patient) return res.redirect("/login-register");

  const patientId = req.session.patient.id;
  const { doctor_id, appointment_date, appointment_time, reason } = req.body;

  if (!doctor_id || !appointment_date || !appointment_time) {
    return res.send("Please select doctor, date and time. <a href='/book-appointment'>Go back</a>");
  }

  const checkSql = `SELECT COUNT(*) AS cnt FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ?`;
  conn.query(checkSql, [doctor_id, appointment_date, appointment_time], (err, rows) => {
    if (err) {
      console.error("Error checking availability:", err);
      return res.send("Error creating appointment.");
    }

    if (rows && rows[0] && rows[0].cnt > 0) {
      return res.send("Selected slot is already booked. Please choose another time. <a href='/book-appointment'>Back</a>");
    }

    const insertSql = `
      INSERT INTO appointments (patient_id, doctor_id, appointment_date, appointment_time, status, reason)
      VALUES (?, ?, ?, ?, 'Pending', ?)
    `;
    conn.query(insertSql, [patientId, doctor_id, appointment_date, appointment_time, reason || null], (err2) => {
      if (err2) {
        console.error("Error inserting appointment:", err2);
        if (err2.code === "ER_DUP_ENTRY") {
          return res.send("Slot just got taken. Please choose another time. <a href='/book-appointment'>Back</a>");
        }
        return res.send("Error creating appointment.");
      }
      // success - render existing success view if you have one
      return res.render("success", {
        title: "Appointment Booked",
        message: "Your appointment request was submitted. Admin will confirm it soon.",
        redirect: "/my-appointments",
      });
    });
  });
});

// ---------------- Admin Routes ----------------
app.get("/admin-login", (req, res) => res.render("admin-login"));

app.post("/admin-login", (req, res) => {
  const { email, password } = req.body;
  if (email === "admin@clinic.com" && password === "admin123") {
    req.session.admin = true;
    res.redirect("/admin-dashboard");
  } else {
    res.send("Invalid admin credentials. <a href='/admin-login'>Try again</a>");
  }
});

app.get("/admin-dashboard", (req, res) => {
  if (!req.session.admin) return res.redirect("/admin-login");

  const sql = `
    SELECT 
      appointments.id, 
      patients.name AS patient_name, 
      patients.email AS patient_email, 
      doctors.name AS doctor_name, 
      appointments.appointment_date AS date, 
      appointments.appointment_time AS time
    FROM appointments 
    JOIN patients ON appointments.patient_id = patients.id 
    JOIN doctors ON appointments.doctor_id = doctors.id
  `;
  conn.query(sql, (err, appointments) => {
    if (err) {
      console.error("Error fetching admin appointments:", err);
      return res.send("Error fetching appointments");
    }
    res.render("admin-dashboard", { appointments, session: req.session });
  });
});

// Admin Logout
app.get("/admin-logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error during admin logout:", err);
      return res.send("Error logging out. Please try again.");
    }
    res.redirect("/admin-login");
  });
});

// Delete Appointment
app.get("/delete-appointment/:id", (req, res) => {
  if (!req.session.admin) return res.redirect("/admin-login");

  const id = req.params.id;
  conn.query("DELETE FROM appointments WHERE id = ?", [id], (err) => {
    if (err) {
      console.error("Error deleting appointment:", err);
      return res.send("Error deleting appointment");
    }
    res.redirect("/admin-dashboard");
  });
});

// Add Doctor
app.get("/add-doctor", (req, res) => res.render("add-doctor"));

app.post("/add-doctor", (req, res) => {
  const { name, specialization, email, available_from, available_to } = req.body;
  let available_days = req.body.available_days;

  if (Array.isArray(available_days)) {
    available_days = available_days.join(", ");
  }

  if (available_from >= available_to) {
    return res.send("❌ Error: 'Available From' must be earlier than 'Available To'. <a href='/add-doctor'>Go Back</a>");
  }

  const sql = `
    INSERT INTO doctors (name, specialization, email, available_days, available_from, available_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  conn.query(sql, [name, specialization, email, available_days, available_from, available_to], (err) => {
    if (err) {
      console.error("Error adding doctor:", err);
      if (err.code === "ER_DUP_ENTRY") {
        res.send("❌ Doctor already exists! <a href='/add-doctor'>Go back</a>");
      } else {
        res.send("Something went wrong!");
      }
    } else {
      res.send("✅ Doctor added successfully! <a href='/add-doctor'>Add Another</a>");
    }
  });
});

// View All Appointments (Admin)
app.get("/view-appointments", (req, res) => {
  const sql = `
    SELECT 
      a.*, 
      d.name AS doctor_name, 
      d.specialization,
      p.name AS patient_name,
      p.email,
      p.phone
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN patients p ON a.patient_id = p.id
    ORDER BY a.appointment_date DESC, a.appointment_time DESC
  `;
  conn.query(sql, (err, appointments) => {
    if (err) {
      console.error("Error in view-appointments:", err);
      throw err;
    }
    res.render("view-appointments", { appointments });
  });
});

// Export Appointments to PDF
app.get("/export-appointments", (req, res) => {
  if (!req.session.admin && !req.session.patient) {
    return res.redirect("/login-register");
  }

  let sql = `
    SELECT appointments.id, 
           patients.name AS patient_name, 
           patients.email AS patient_email,
           doctors.name AS doctor_name,
           doctors.specialization AS doctor_specialization,
           appointments.appointment_date, 
           appointments.appointment_time
    FROM appointments 
    JOIN doctors ON appointments.doctor_id = doctors.id
    JOIN patients ON appointments.patient_id = patients.id
  `;
  const params = [];

  if (req.session.patient) {
    sql += ` WHERE patients.id = ?`;
    params.push(req.session.patient.id);
  }

  conn.query(sql, params, (err, appointments) => {
    if (err || appointments.length === 0) {
      console.error("Error fetching appointments for PDF:", err);
      return res.redirect("/dashboard");
    }

    const doc = new PDFDocument();
    const stream = new PassThrough();

    res.setHeader("Content-Disposition", "attachment; filename=appointments.pdf");
    res.setHeader("Content-Type", "application/pdf");

    doc.pipe(stream);
    stream.pipe(res);

    doc.fontSize(24).fillColor("#0077b6").text("HealthCare Clinic", { align: "center" });
    doc.fontSize(14).fillColor("#444").text("Clinic Appointments Report", { align: "center" }).moveDown(2);

    appointments.forEach((a, index) => {
      const dateStr = new Date(a.appointment_date).toDateString();
      doc
        .fontSize(12)
        .fillColor("black")
        .text(`${index + 1}. Patient: ${a.patient_name} (${a.patient_email})`)
        .text(`   Doctor: ${a.doctor_name}`)
        .text(`   Specialization: ${a.doctor_specialization || "N/A"}`)
        .text(`   Date: ${dateStr}`)
        .text(`   Time: ${a.appointment_time}`)
        .moveDown();

      doc.strokeColor("#cccccc").lineWidth(0.5).moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();
    });

    doc.fontSize(10).fillColor("#555").text(`Generated on ${new Date().toLocaleString()}`, 50, 760, { align: "center" });
    doc.end();
  });
});

// ---------------- Start Server ----------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
