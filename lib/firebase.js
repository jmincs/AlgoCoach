// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAGTFVn7ZboHTXwb7JMXzd1Ixv4wFB0kwI",
  authDomain: "codebuddy-bdfae.firebaseapp.com",
  projectId: "codebuddy-bdfae",
  storageBucket: "codebuddy-bdfae.firebasestorage.app",
  messagingSenderId: "128666578167",
  appId: "1:128666578167:web:1381b95777ff2b412137f2",
  measurementId: "G-9XWXVNZLRN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);