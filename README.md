# ToDo Application for AWS ECS

This is a simple ToDo application built with Express.js and Handlebars, designed to be deployed on AWS ECS (Elastic Container Service).

## Local Development

### Prerequisites

- Node.js (v18 or later)
- npm (usually comes with Node.js)
- Docker (for building and testing the container locally)

### Setup

1. Clone this repository:
   ```
   git clone <repository-url>
   cd ECS
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```

4. Open a web browser and navigate to `http://localhost:3000` to use the application.

## Deploying to AWS ECS

### Prerequisites

- AWS CLI installed and configured
- Docker installed
- An AWS ECR repository to store your Docker image
- An ECS cluster set up in your AWS account

### Steps to Deploy

1. Build the Docker image:
   ```
   docker build -t todo-app .
   ```

2. Tag the image for your ECR repository:
   ```
   docker tag todo-app:latest <your-account-id>.dkr.ecr.<your-region>.amazonaws.com/todo-app:latest
   ```

3. Log in to your ECR repository:
   ```
   aws ecr get-login-password --region <your-region> | docker login --username AWS --password-stdin <your-account-id>.dkr.ecr.<your-region>.amazonaws.com
   ```

4. Push the image to ECR:
   ```
   docker push <your-account-id>.dkr.ecr.<your-region>.amazonaws.com/todo-app:latest
   ```

5. Create a task definition:
   - Go to the ECS console in AWS
   - Click on "Task Definitions" in the left sidebar
   - Click "Create new Task Definition"
   - Choose "EC2" or "Fargate" launch type compatibility
   - Fill in the necessary details, using the ECR image you just pushed
   - Configure the container port to 3000

6. Create or update an ECS service:
   - Go to your ECS cluster
   - Click "Create" under the "Services" tab
   - Choose your task definition and configure the service details
   - Set up your desired number of tasks, networking, and load balancing options

7. Once the service is created and the tasks are running, you should be able to access your application via the provided load balancer URL or the public IP of the EC2 instance (if using EC2 launch type without a load balancer).

## Monitoring and Scaling

- Use CloudWatch to monitor the performance and health of your ECS tasks
- Set up Auto Scaling for your ECS service to handle varying loads

## Cleaning Up

To avoid incurring unnecessary charges, remember to delete your resources when you're done:
- Delete the ECS service
- Deregister the task definition
- Delete the ECR repository
- If created, delete the load balancer and target groups
- If you created a new ECS cluster just for this app, you can delete that too

## Troubleshooting

- Check ECS task logs in CloudWatch for any application errors
- Ensure security groups are configured to allow traffic on port 3000
- Verify that the container health check in your task definition is appropriate for your application

For more detailed information on ECS deployments, refer to the [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/index.html).