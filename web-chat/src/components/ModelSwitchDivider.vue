<script setup lang="ts">
defineProps<{ dominioNome: string }>();
</script>

<template>
    <div class="my-6 flex items-center gap-3">
        <svg class="h-3 flex-1 text-neutral-300 dark:text-white/15" viewBox="0 0 400 12" preserveAspectRatio="none">
            <path
                d="M0,6 C 16.7,0 33.3,12 50,6 C 66.7,0 83.3,12 100,6 C 116.7,0 133.3,12 150,6 C 166.7,0 183.3,12 200,6 C 216.7,0 233.3,12 250,6 C 266.7,0 283.3,12 300,6 C 316.7,0 333.3,12 350,6 C 366.7,0 383.3,12 400,6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
            />
        </svg>
        <span
            class="shrink-0 rounded-full bg-neutral-100 px-3.5 py-1.5 text-xs font-medium whitespace-nowrap text-neutral-500 dark:border dark:border-white/10 dark:bg-white/10 dark:text-neutral-300 dark:backdrop-blur-md"
        >
            Modelo alterado para "{{ dominioNome }}"
        </span>
        <svg class="h-3 flex-1 text-neutral-300 dark:text-white/15" viewBox="0 0 400 12" preserveAspectRatio="none">
            <path
                d="M0,6 C 16.7,0 33.3,12 50,6 C 66.7,0 83.3,12 100,6 C 116.7,0 133.3,12 150,6 C 166.7,0 183.3,12 200,6 C 216.7,0 233.3,12 250,6 C 266.7,0 283.3,12 300,6 C 316.7,0 333.3,12 350,6 C 366.7,0 383.3,12 400,6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
            />
        </svg>
    </div>
</template>
