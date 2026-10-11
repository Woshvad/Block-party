"use client";
import dynamic from 'next/dynamic';
const Preview=dynamic(()=>import('../../src/RoomSocialPreview'),{ssr:false});
export default function View(){return <Preview/>;}
