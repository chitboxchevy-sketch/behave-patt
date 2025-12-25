import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, setDoc, getDocs } from 'firebase/firestore';

// Ensure __app_id and __firebase_config are defined in the environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Main App component
const App = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [showInfo, setShowInfo] = useState(true); // State to control visibility of info message
    const messagesEndRef = useRef(null);

    // Initialize Firebase and set up authentication listener
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authentication = getAuth(app);

            setDb(firestore);
            setAuth(authentication);

            const unsubscribe = onAuthStateChanged(authentication, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    setIsAuthReady(true);
                } else {
                    // Sign in anonymously if no token is provided or user is not authenticated
                    try {
                        if (initialAuthToken) {
                            await signInWithCustomToken(authentication, initialAuthToken);
                        } else {
                            await signInAnonymously(authentication);
                        }
                    } catch (error) {
                        console.error("Error signing in:", error);
                        setIsAuthReady(true); // Still set ready even if sign-in fails to avoid infinite loading
                    }
                }
            });

            return () => unsubscribe();
        } catch (error) {
            console.error("Firebase initialization failed:", error);
            setIsAuthReady(true); // Mark as ready even on error to prevent infinite loading
        }
    }, []);

    // Fetch messages from Firestore
    useEffect(() => {
        if (!db || !userId || !isAuthReady) return;

        // Path for private chat history
        const messagesCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/chat_history`);
        const q = query(messagesCollectionRef, orderBy('timestamp'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedMessages = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setMessages(fetchedMessages);
            scrollToBottom();
        }, (error) => {
            console.error("Error fetching messages:", error);
        });

        return () => unsubscribe();
    }, [db, userId, isAuthReady]);

    // Scroll to the latest message
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    // Handle sending a message
    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!newMessage.trim() || !db || !userId) return;

        setIsLoading(true);
        const userMessage = newMessage.trim();
        setNewMessage('');

        try {
            // Add user message to Firestore
            await addDoc(collection(db, `artifacts/${appId}/users/${userId}/chat_history`), {
                sender: 'user',
                text: userMessage,
                timestamp: serverTimestamp()
            });

            // Check for training command
            if (userMessage.startsWith('/teach ')) {
                const parts = userMessage.substring('/teach '.length).split('" "');
                if (parts.length === 2) {
                    const question = parts[0].replace(/"/g, '');
                    const answer = parts[1].replace(/"/g, '');
                    await saveTrainingData(question, answer);
                    await sendBotResponse("Acknowledged. I've noted that for future reference.", 'bot');
                } else {
                    await sendBotResponse("Invalid /teach command. Use: /teach \"question\" \"answer\"", 'bot');
                }
            } else if (userMessage.startsWith('/clear')) {
                // Clear chat history (client-side only for now, could add server-side clear)
                setMessages([]);
                await sendBotResponse("Chat history cleared.", 'bot');
            } else {
                // Get bot response from LLM
                await getBotResponse(userMessage);
            }
        } catch (error) {
            console.error("Error sending message or processing command:", error);
            await sendBotResponse("Oops! Something went wrong. Please try again.", 'bot');
        } finally {
            setIsLoading(false);
        }
    };

    // Send bot response to Firestore
    const sendBotResponse = async (text, sender = 'bot') => {
        if (!db || !userId) return;
        await addDoc(collection(db, `artifacts/${appId}/users/${userId}/chat_history`), {
            sender: sender,
            text: text,
            timestamp: serverTimestamp()
        });
    };

    // Save training data to Firestore
    const saveTrainingData = async (question, answer) => {
        if (!db || !userId) return;
        const trainingDataRef = doc(db, `artifacts/${appId}/users/${userId}/training_data`, question.toLowerCase());
        await setDoc(trainingDataRef, {
            question: question,
            answer: answer,
            timestamp: serverTimestamp()
        }, { merge: true }); // Use merge to update if exists
    };

    // Get bot response from LLM
    const getBotResponse = async (userMessage) => {
        try {
            // Fetch training data to provide context to the LLM
            const trainingDataCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/training_data`);
            const trainingSnapshot = await getDocs(trainingDataCollectionRef);
            const trainingData = trainingSnapshot.docs.map(doc => doc.data());

            let chatHistoryForLLM = messages.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'model',
                parts: [{ text: msg.text }]
            }));

            // Add training data to the prompt for context
            const trainingContext = trainingData.map(data => `User asked "${data.question}", I responded "${data.answer}".`).join('\n');
            const prompt = `You are a blank chatbot being trained. Here's some training data I've provided you:\n${trainingContext}\n\nBased on our conversation history and the training data, please respond to the following:\n${userMessage}`;

            chatHistoryForLLM.push({ role: "user", parts: [{ text: prompt }] });

            const payload = { contents: chatHistoryForLLM };
            const apiKey = ""; // Canvas will provide this at runtime
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=\${apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const botText = result.candidates[0].content.parts[0].text;
                await sendBotResponse(botText, 'bot');
            } else {
                console.warn("LLM response structure unexpected:", result);
                await sendBotResponse("I'm not sure how to respond to that. Can you rephrase?", 'bot');
            }
        } catch (error) {
            console.error("Error getting bot response from LLM:", error);
            await sendBotResponse("I'm sorry, I'm having trouble connecting right now. Please try again later.", 'bot');
        }
    };

    // Toggle info message visibility
    const toggleInfo = () => {
        setShowInfo(!showInfo);
    };

    // Get user's location
    useEffect(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(async (position) => {
                const latitude = position.coords.latitude;
                const longitude = position.coords.longitude;
                console.log("Latitude:", latitude, "Longitude:", longitude);

                // Send location data to your server or perform any other action
               
