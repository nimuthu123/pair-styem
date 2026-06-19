// message.js
export const Messages = {
    WELCOME_MESSAGE: (phoneNumber) => {
        return `✅ Connection successful!

📱 Your number: ${phoneNumber}
⏳ Please wait 1 minute for the bot to initialize.

✨ Bot is now ready to use!`;
    },
    // ඔබට අවශ්‍ය නම් මෙතැනට තවත් පණිවිඩ එකතු කළ හැක
    GOODBYE_MESSAGE: "Disconnected successfully.",
    ERROR_MESSAGE: "An error occurred. Please try again.",
    PAIRING_CODE_MESSAGE: (code) => {
        return `Your pairing code is: ${code}`;
    }
};