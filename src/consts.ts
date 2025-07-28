import type { Site, Metadata, Socials } from "@types";

export const SITE: Site = {
  NAME: "Aryan Mehesare",
  EMAIL: "aryanmehesare@gmail.com",
  NUM_POSTS_ON_HOMEPAGE: 2,
  NUM_WORKS_ON_HOMEPAGE: 2,
  NUM_PROJECTS_ON_HOMEPAGE: 2,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION: "Welcome to my portfolio, where I share my work and thoughts.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "A collection of articles on topics I am passionate about.",
};

export const WORK: Metadata = {
  TITLE: "Work",
  DESCRIPTION: "Where I have worked and what I have done.",
};

export const PROJECTS: Metadata = {
  TITLE: "Projects",
  DESCRIPTION: "A collection of my projects, with links to repositories.",
};

export const SOCIALS: Socials = [
  {
    NAME: "x.com",
    HREF: "https://x.com/mortal22soul",
  },
  {
    NAME: "github",
    HREF: "https://github.com/mortal22soul",
  },
  {
    NAME: "linkedin",
    HREF: "https://www.linkedin.com/in/aryanmehesare",
  },
];
