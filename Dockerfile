# Use an official Node runtime as the parent image
FROM node:18

# Set the working directory in the container to /app
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install any needed packages specified in package.json
RUN npm install

# Bundle app source inside the docker image
COPY . .

# Make port 3000 available to the world outside this container
EXPOSE 80

# Define the command to run your app using CMD which defines your runtime
CMD [ "npm", "start" ]