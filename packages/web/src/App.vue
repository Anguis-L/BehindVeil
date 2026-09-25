<script setup lang="ts">
import { useSessionStore } from './stores/session';
import JoinPage from './pages/JoinPage.vue';
import RoomPage from './pages/RoomPage.vue';

const store = useSessionStore();
</script>

<template>
  <JoinPage v-if="store.view === 'join'" />
  <RoomPage v-else />
</template>
