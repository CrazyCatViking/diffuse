import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';

import App from './App.vue';
import './style.scss';

import { routes } from './routes';

const router = createRouter({
  history: createMemoryHistory(),
  routes,
});

createApp(App).use(createPinia()).use(router).mount('#app');
