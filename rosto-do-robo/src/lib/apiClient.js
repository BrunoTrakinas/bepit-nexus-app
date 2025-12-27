// src/api/apiClient.js
import axios from 'axios';


const api = axios.create({
baseURL: import.meta.env.VITE_API_BASE_URL,
timeout: 20000,
// withCredentials: false, // desnecessário se não usa cookies
});


// Interceptor opcional para logs
api.interceptors.response.use(
(res) => res,
(err) => {
console.error('[API Error]', err?.response?.status, err?.response?.data || err.message);
return Promise.reject(err);
}
);


export default api;