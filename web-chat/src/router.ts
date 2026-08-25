import { createRouter, createWebHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';
import AvaliarResultados from './components/AvaliarResultados.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', name: 'chat', component: ChatView },
        { path: '/avaliar', name: 'avaliar', component: AvaliarResultados },
    ],
});

export default router;
