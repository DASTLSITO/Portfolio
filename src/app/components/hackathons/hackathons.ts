import { Component } from '@angular/core';

interface Hackathon {
  title: string;
  scope: 'Local' | 'Regional';
  location: string;
  date: string;
  description: string;
  tags: string[];
}

@Component({
  imports: [],
  selector: 'app-hackathons',
  styleUrl: './hackathons.css',
  templateUrl: './hackathons.html',
})
export class Hackathons {
  /** Chronological, oldest first: reads left to right on the desktop timeline. */
  protected readonly events: Hackathon[] = [
    {
      title: 'Pacific Sardine Occurrence Predictor',
      scope: 'Local',
      location: 'La Paz, Baja California Sur',
      date: 'Apr 2025',
      description:
        'Developed a Django API and web interface for a neural network that predicts the probability of Pacific sardine occurrence based on geographic coordinates.',
      tags: ['Python', 'Django', 'REST APIs', 'Neural Network'],
    },
    {
      title: 'Real-Time Sentiment Analysis',
      scope: 'Regional',
      location: 'Hermosillo, Sonora',
      date: 'Oct 2025',
      description:
        'Built an n8n agent using Mistral AI to classify social media comments and calculate real-time sentiment percentages.',
      tags: ['n8n', 'Mistral AI', 'JavaScript'],
    },
    {
      title: 'Personalized Travel Itineraries',
      scope: 'Local',
      location: 'La Paz, Baja California Sur',
      date: 'Apr 2026',
      description:
        'Developed a Flutter application that generates personalized travel itineraries using Word2Vec recommendations and Google APIs.',
      tags: ['Flutter', 'Word2Vec', 'Google APIs'],
    },
    {
      title: 'AI Agents for IT Support',
      scope: 'Regional',
      location: 'Chihuahua, Chihuahua',
      date: 'Oct 2026',
      description:
        'Built a service with agents using LangChain and Gemini AI APIs to solve problems in the IT area.',
      tags: ['LangChain', 'Gemini AI', 'Python', 'AI Agents'],
    },
  ];

  protected readonly technologies = [
    'Python',
    'Django',
    'Flutter',
    'JavaScript',
    'Word2Vec',
    'n8n',
    'Mistral AI',
    'REST APIs',
    'Google APIs',
    'LangChain',
  ];
}
