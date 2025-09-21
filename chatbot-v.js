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
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

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

    if (!isAuthReady) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
                <div className="text-lg text-gray-700 dark:text-gray-300">Loading chatbot...</div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-inter">
            {/* Header */}
            <header className="bg-gradient-to-r from-blue-600 to-purple-700 p-4 text-white shadow-md flex justify-between items-center rounded-b-xl">
                <h1 className="text-2xl font-bold">Impressionable Chatbot</h1>
                <button
                    onClick={toggleInfo}
                    className="p-2 rounded-full bg-white bg-opacity-20 hover:bg-opacity-30 transition-all duration-200"
                    aria-label="Toggle information"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                </button>
            </header>

            {/* Info Message */}
            {showInfo && (
                <div className="bg-blue-100 dark:bg-blue-900 p-4 m-4 rounded-lg shadow-inner text-blue-800 dark:text-blue-200">
                    <p className="mb-2">This is your impressionable chatbot. You can chat with it normally, or you can "train" it with specific Q&A pairs.</p>
                    <p className="mb-2">To train, use the command: <code className="font-mono bg-blue-200 dark:bg-blue-800 px-2 py-1 rounded">/teach "your question" "your answer"</code></p>
                    <p className="mb-2">Example: <code className="font-mono bg-blue-200 dark:bg-blue-800 px-2 py-1 rounded">/teach "What is your favorite color?" "My favorite color is blue."</code></p>
                    <p className="mb-2">Your user ID: <code className="font-mono bg-blue-200 dark:bg-blue-800 px-2 py-1 rounded break-all">{userId}</code></p>
                    <p>Type <code className="font-mono bg-blue-200 dark:bg-blue-800 px-2 py-1 rounded">/clear</code> to clear the chat history.</p>
                </div>
            )}

            {/* Chat Messages Area */}
            <main className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {messages.length === 0 && !isLoading && (
                    <div className="text-center text-gray-500 dark:text-gray-400 mt-10">
                        Start chatting or train your bot!
                    </div>
                )}
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div
                            className={`max-w-xs sm:max-w-sm md:max-w-md lg:max-w-lg xl:max-w-xl p-3 rounded-xl shadow-md
                                ${msg.sender === 'user'
                                    ? 'bg-blue-500 text-white rounded-br-none'
                                    : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-bl-none'
                                }`}
                        >
                            <p className="text-sm">{msg.text}</p>
                            <span className="text-xs opacity-75 mt-1 block">
                                {msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString() : 'Sending...'}
                            </span>
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="flex justify-start">
                        <div className="max-w-xs sm:max-w-sm md:max-w-md lg:max-w-lg xl:max-w-xl p-3 rounded-xl shadow-md bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-bl-none">
                            <div className="flex items-center">
                                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 dark:border-gray-100 mr-2"></span>
                                Thinking...
                            </div>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </main>

            {/* Message Input */}
            <form onSubmit={handleSendMessage} className="p-4 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex items-center rounded-t-xl shadow-lg">
                <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Type your message or /teach \"Q\" \"A\"..."
                    className="flex-1 p-3 border border-gray-300 dark:border-gray-600 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100 transition-all duration-200"
                    disabled={isLoading}
                />
                <button
                    type="submit"
                    className="ml-3 p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={isLoading}
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path>
                    </svg>
                </button>
            </form>

            {/* Tailwind CSS Script */}
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
                .font-inter {{
                    font-family: 'Inter', sans-serif;
                }}
                /* Custom scrollbar for better aesthetics */
                .custom-scrollbar::-webkit-scrollbar {{
                    width: 8px;
                }}
                .custom-scrollbar::-webkit-scrollbar-track {{
                    background: #f1f1f1;
                    border-radius: 10px;
                }}
                .custom-scrollbar::-webkit-scrollbar-thumb {{
                    background: #888;
                    border-radius: 10px;
                }}
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {{
                    background: #555;
                }}
                .dark .custom-scrollbar::-webkit-scrollbar-track {{
                    background: #333;
                }}
                .dark .custom-scrollbar::-webkit-scrollbar-thumb {{
                    background: #555;
                }}
                .dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {{
                    background: #777;
                }}
            </style>
        </div>
    );
};

export default App;