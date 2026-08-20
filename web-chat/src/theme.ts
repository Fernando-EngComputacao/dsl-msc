import { ref } from 'vue';

const CHAVE = 'spc-cml-tema';

export const escuro = ref(false);

function aplicar(valor: boolean): void {
    document.documentElement.classList.toggle('dark', valor);
}

export function iniciarTema(): void {
    const salvo = localStorage.getItem(CHAVE);
    escuro.value = salvo ? salvo === 'escuro' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    aplicar(escuro.value);
}

export function alternarTema(): void {
    escuro.value = !escuro.value;
    localStorage.setItem(CHAVE, escuro.value ? 'escuro' : 'claro');
    aplicar(escuro.value);
}
