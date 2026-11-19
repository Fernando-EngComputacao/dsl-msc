import { createRouter, createWebHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';
import AvaliarResultados from './components/AvaliarResultados.vue';
import FundirResultados from './views/FundirResultados.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', name: 'chat', component: ChatView },
        { path: '/avaliar', name: 'avaliar', component: AvaliarResultados },
        { path: '/fundir', name: 'fundir', component: FundirResultados },
    ],
});

export default router;
